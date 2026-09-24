using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentRequestBuilder
    {
        private const string SegmentEntityName = "msdynmkt_segmentdefinition";
        private const string SegmentQueryAttribute = "msdynmkt_segmentquery";
        private const int StaticPageSize = 5000;
        private const int MaximumMetadataCacheEntries = 128;
        private const int MaximumRequestCacheEntries = 32;
        private static readonly TimeSpan MetadataCacheTtl = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan RequestCacheTtl = TimeSpan.FromSeconds(20);
        private static readonly object SharedCacheLock = new object();
        private static readonly Dictionary<string, CacheEntry<FabricRelationshipResolution>>
            SharedRelationshipCache =
                new Dictionary<string, CacheEntry<FabricRelationshipResolution>>(
                    StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, CacheEntry<string>>
            SharedPrimaryIdCache =
                new Dictionary<string, CacheEntry<string>>(
                    StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, CacheEntry<string>>
            SharedRequestCache =
                new Dictionary<string, CacheEntry<string>>(
                    StringComparer.OrdinalIgnoreCase);
        private readonly IOrganizationService service;
        private readonly Guid organizationId;
        private readonly Dictionary<string, FabricRelationshipResolution> relationshipCache;
        private readonly Dictionary<string, string> primaryIdCache;

        public FabricSegmentRequestBuilder(
            IOrganizationService service,
            Guid organizationId)
        {
            this.service = service;
            this.organizationId = organizationId;
            relationshipCache =
                new Dictionary<string, FabricRelationshipResolution>(
                    StringComparer.OrdinalIgnoreCase);
            primaryIdCache =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        public FabricSegmentRequestBuildTimings Timings { get; private set; } =
            new FabricSegmentRequestBuildTimings();

        public FabricSegmentCountApiRequest Build(
            Guid segmentDefinitionId,
            bool businessUnitScopingEnabled)
        {
            var recursionPath = new HashSet<Guid>();
            if (!recursionPath.Add(segmentDefinitionId))
            {
                throw new InvalidPluginExecutionException(
                    "The segment references contain a cycle at " +
                    segmentDefinitionId.ToString("D") + ".");
            }

            try
            {
                var definition = RetrieveDefinition(segmentDefinitionId);
                var cacheKey = BuildRequestCacheKey(
                    segmentDefinitionId,
                    definition.Contains("modifiedon")
                        ? (DateTime?)definition.GetAttributeValue<DateTime>(
                            "modifiedon")
                        : null,
                    businessUnitScopingEnabled);
                FabricSegmentCountApiRequest cached;
                if (TryGetRequest(cacheKey, out cached))
                {
                    Timings.Cache = "hit";
                    return cached;
                }

                var businessUnit = definition.GetAttributeValue<EntityReference>(
                    "owningbusinessunit");
                if (businessUnitScopingEnabled && businessUnit == null)
                {
                    throw new InvalidPluginExecutionException(
                        "Business-unit scoping is enabled, but the segment definition " +
                        segmentDefinitionId.ToString("D") +
                        " has no owning business unit.");
                }

                var query = BuildQuery(ParseMql(definition), recursionPath);
                query.BusinessUnitId = businessUnitScopingEnabled
                    ? (Guid?)businessUnit.Id
                    : null;
                var request = new FabricSegmentCountApiRequest { Query = query };
                Timings.Cache = "miss";
                if (!ContainsStaticMembers(request.Query))
                {
                    StoreRequest(cacheKey, request);
                }

                return request;
            }
            finally
            {
                recursionPath.Remove(segmentDefinitionId);
            }
        }

        private FabricSegmentQueryRequest BuildDefinition(
            Guid definitionId,
            ISet<Guid> recursionPath)
        {
            if (!recursionPath.Add(definitionId))
            {
                throw new InvalidPluginExecutionException(
                    "The segment references contain a cycle at " +
                    definitionId.ToString("D") + ".");
            }

            try
            {
                var definition = RetrieveDefinition(definitionId);
                return BuildDefinition(definition, recursionPath);
            }
            finally
            {
                recursionPath.Remove(definitionId);
            }
        }

        private FabricSegmentQueryRequest BuildDefinition(
            Entity definition,
            ISet<Guid> recursionPath)
        {
            return BuildQuery(ParseMql(definition), recursionPath);
        }

        private Entity RetrieveDefinition(Guid definitionId)
        {
            var timer = Stopwatch.StartNew();
            try
            {
                return service.Retrieve(
                    SegmentEntityName,
                    definitionId,
                    new ColumnSet(
                        SegmentQueryAttribute,
                        "owningbusinessunit",
                        "modifiedon"));
            }
            finally
            {
                Timings.SegmentRetrieve += timer.Elapsed.TotalMilliseconds;
            }
        }

        private SegmentQuery ParseMql(Entity definition)
        {
            var timer = Stopwatch.StartNew();
            try
            {
                return new MqlParser(ReadSegmentQuery(definition)).Parse();
            }
            finally
            {
                Timings.MqlParsing += timer.Elapsed.TotalMilliseconds;
            }
        }

        private static string ReadSegmentQuery(Entity definition)
        {
            var mql = definition.GetAttributeValue<string>(SegmentQueryAttribute);
            if (string.IsNullOrWhiteSpace(mql))
            {
                throw new InvalidPluginExecutionException(
                    "The segment definition " + definition.Id.ToString("D") +
                    " does not contain an MQL query.");
            }

            return mql;
        }

        private FabricSegmentQueryRequest BuildQuery(
            SegmentQuery query,
            ISet<Guid> recursionPath)
        {
            return new FabricSegmentQueryRequest
            {
                FirstOperand = BuildOperand(query.FirstOperand, recursionPath),
                SetOperations = query.SetOperations
                    .Select(operation => new FabricSegmentSetOperationRequest
                    {
                        Operator = operation.Operator.ToString().ToUpperInvariant(),
                        Operand = BuildOperand(operation.Operand, recursionPath),
                        Label = operation.Operator == SetOperator.Intersect
                            ? "Intersection"
                            : operation.Operator == SetOperator.Union
                                ? "Union"
                                : "Exclusion",
                        Detail = operation.Operator.ToString().ToUpperInvariant() +
                            " " + DescribeSetOperand(operation.Operand)
                    })
                    .ToList()
            };
        }

        private FabricSegmentOperandRequest BuildOperand(
            SegmentOperand operand,
            ISet<Guid> recursionPath)
        {
            var profile = operand as ProfileOperand;
            if (profile != null)
            {
                return BuildProfileOperand(profile);
            }

            var interaction = operand as InteractionOperand;
            if (interaction != null)
            {
                var profileEntity = interaction.ResolveProfileEntity();
                return new FabricSegmentOperandRequest
                {
                    Kind = "interaction",
                    ProfileEntity = profileEntity,
                    BaseLabel = "Behavioral: " + interaction.EventLogicalName,
                    BaseDetail = interaction.Describe(),
                    EventLogicalName = interaction.EventLogicalName,
                    EntityIdField = interaction.EntityIdField,
                    Filter = ConvertCondition(interaction.Filter, false),
                    Having = new FabricSegmentHavingRequest
                    {
                        Metric = interaction.Having.Metric,
                        Operator = interaction.Having.ComparisonOperator,
                        Threshold = interaction.Having.Threshold,
                        WindowFunction = interaction.Having.WindowFunction,
                        WindowValue = interaction.Having.WindowValue
                    }
                };
            }

            var segment = operand as SegmentReferenceOperand;
            if (segment != null)
            {
                return BuildSegmentReference(segment.SegmentId, recursionPath);
            }

            throw new InvalidPluginExecutionException(
                "The segment definition contains an unknown operand.");
        }

        private FabricSegmentOperandRequest BuildProfileOperand(ProfileOperand profile)
        {
            var result = new FabricSegmentOperandRequest
            {
                Kind = "profile",
                ProfileEntity = profile.EntityName,
                BaseLabel = "Active " + profile.EntityName + " records",
                BaseDetail = "PROFILE(" + profile.EntityName + ")"
            };
            foreach (var filterStep in profile.FilterSteps)
            {
                var profileFilter = filterStep as ProfileFilterStep;
                if (profileFilter != null)
                {
                    foreach (var condition in FlattenAnd(profileFilter.Condition))
                    {
                        result.Steps.Add(new FabricSegmentFilterStepRequest
                        {
                            Kind = "profile",
                            Label = "Profile filter",
                            Detail = condition.Describe(),
                            Condition = ConvertCondition(condition, true)
                        });
                    }

                    continue;
                }

                var relationship = filterStep as RelationshipFilterStep;
                if (relationship == null)
                {
                    throw new InvalidPluginExecutionException(
                        "The segment definition contains an unknown profile filter.");
                }

                var relationships = ResolveRelationshipPath(
                    profile.EntityName,
                    relationship.Relationship);
                var firstRelationship = relationships[0];
                var supportsLegacyRelationship =
                    relationships.Count == 1 &&
                    string.IsNullOrWhiteSpace(firstRelationship.IntersectEntity);
                ConditionNode accumulated = null;
                foreach (var condition in FlattenAnd(relationship.Condition))
                {
                    accumulated = accumulated == null
                        ? condition
                        : new AndCondition(new[] { accumulated, condition });
                    result.Steps.Add(new FabricSegmentFilterStepRequest
                    {
                        Kind = "relationship",
                        Label = "Relationship filter " + relationship.RelationshipSchema,
                        Detail = accumulated.Describe(),
                        Condition = ConvertCondition(accumulated, false),
                        RelatedEntity = supportsLegacyRelationship
                            ? firstRelationship.RelatedEntity
                            : null,
                        ProfileAttribute = supportsLegacyRelationship
                            ? firstRelationship.SourceAttribute
                            : null,
                        RelatedAttribute = supportsLegacyRelationship
                            ? firstRelationship.RelatedAttribute
                            : null,
                        IsOptional = relationship.IsOptional,
                        Relationships = relationships
                    });
                }
            }

            return result;
        }

        private List<FabricRelationshipHopRequest> ResolveRelationshipPath(
            string profileEntity,
            RelationshipPath relationshipPath)
        {
            var result = new List<FabricRelationshipHopRequest>();
            var currentEntity = profileEntity;
            var current = relationshipPath;
            while (current != null)
            {
                var resolved = ResolveRelationship(
                    currentEntity,
                    current.RelationshipSchema);
                result.Add(new FabricRelationshipHopRequest
                {
                    Alias = current.Alias,
                    RelatedEntity = resolved.RelatedEntity,
                    SourceAttribute = string.IsNullOrWhiteSpace(resolved.IntersectEntity)
                        ? resolved.ProfileAttribute
                        : null,
                    RelatedAttribute = string.IsNullOrWhiteSpace(resolved.IntersectEntity)
                        ? resolved.RelatedAttribute
                        : null,
                    SourcePrimaryAttribute = string.IsNullOrWhiteSpace(resolved.IntersectEntity)
                        ? null
                        : resolved.ProfileAttribute,
                    RelatedPrimaryAttribute = string.IsNullOrWhiteSpace(resolved.IntersectEntity)
                        ? null
                        : resolved.RelatedAttribute,
                    IntersectEntity = resolved.IntersectEntity,
                    SourceIntersectAttribute = resolved.SourceIntersectAttribute,
                    RelatedIntersectAttribute = resolved.RelatedIntersectAttribute,
                    IsOptional = current.IsOptional
                });
                currentEntity = resolved.RelatedEntity;
                current = current.Nested;
            }

            return result;
        }

        private FabricSegmentOperandRequest BuildSegmentReference(
            Guid segmentId,
            ISet<Guid> recursionPath)
        {
            var referenceTimer = Stopwatch.StartNew();
            try
            {
                var retrieveTimer = Stopwatch.StartNew();
                Entity segment;
                try
                {
                    segment = service.Retrieve(
                        "msdynmkt_segment",
                        segmentId,
                        new ColumnSet(
                            "msdynmkt_sourcesegmentuid",
                            "msdynmkt_baseentitylogicalname",
                            "msdynmkt_displayname"));
                }
                finally
                {
                    Timings.SegmentRetrieve +=
                        retrieveTimer.Elapsed.TotalMilliseconds;
                }
            Guid definitionId;
            if (!Guid.TryParse(
                segment.GetAttributeValue<string>("msdynmkt_sourcesegmentuid"),
                out definitionId))
            {
                throw new InvalidPluginExecutionException(
                    "The referenced segment definition for " +
                    segmentId.ToString("D") + " could not be determined.");
            }

            retrieveTimer.Restart();
            Entity definition;
            try
            {
                definition = service.Retrieve(
                    SegmentEntityName,
                    definitionId,
                    new ColumnSet(
                        SegmentQueryAttribute,
                        "msdynmkt_staticlistmembers",
                        "modifiedon"));
            }
            finally
            {
                Timings.SegmentRetrieve += retrieveTimer.Elapsed.TotalMilliseconds;
            }
            var mql = definition.GetAttributeValue<string>(SegmentQueryAttribute);
            var profileEntity =
                segment.GetAttributeValue<string>("msdynmkt_baseentitylogicalname");
            if (string.IsNullOrWhiteSpace(profileEntity))
            {
                profileEntity = "contact";
            }

            if (!string.IsNullOrWhiteSpace(mql))
            {
                if (!recursionPath.Add(definitionId))
                {
                    throw new InvalidPluginExecutionException(
                        "The segment references contain a cycle at " +
                        definitionId.ToString("D") + ".");
                }

                try
                {
                    var query = BuildDefinition(definition, recursionPath);
                    return new FabricSegmentOperandRequest
                    {
                        Kind = "query",
                        ProfileEntity = query.FirstOperand.ProfileEntity,
                        BaseLabel = "Referenced segment",
                        BaseDetail = "SEGMENT(SEGMENT_CJO_ID_" +
                            segmentId.ToString("N") + ")",
                        Query = query
                    };
                }
                finally
                {
                    recursionPath.Remove(definitionId);
                }
            }

                return new FabricSegmentOperandRequest
                {
                    Kind = "static",
                    ProfileEntity = profileEntity,
                    BaseLabel = "Static segment",
                    BaseDetail = "SEGMENT(SEGMENT_CJO_ID_" +
                        segmentId.ToString("N") + ")",
                    ProfileIds = RetrieveStaticSegmentIds(
                        segmentId,
                        definition.GetAttributeValue<string>(
                            "msdynmkt_staticlistmembers"),
                        segment.GetAttributeValue<string>("msdynmkt_displayname"))
                        .ToList()
                };
            }
            finally
            {
                Timings.SegmentReferences +=
                    referenceTimer.Elapsed.TotalMilliseconds;
            }
        }

        private FabricRelationshipResolution ResolveRelationship(
            string profileEntity,
            string relationshipSchema)
        {
            var cacheKey = profileEntity + "|" + relationshipSchema;
            FabricRelationshipResolution cached;
            if (relationshipCache.TryGetValue(cacheKey, out cached))
            {
                return cached;
            }

            var sharedKey = organizationId.ToString("D") + "|" + cacheKey;
            if (TryGetShared(
                SharedRelationshipCache,
                sharedKey,
                out cached))
            {
                relationshipCache.Add(cacheKey, cached);
                return cached;
            }

            var metadataTimer = Stopwatch.StartNew();
            var response = (RetrieveRelationshipResponse)service.Execute(
                new RetrieveRelationshipRequest
                {
                    Name = relationshipSchema,
                    RetrieveAsIfPublished = true
                });
            Timings.RelationshipMetadata +=
                metadataTimer.Elapsed.TotalMilliseconds;
            var relationship =
                response.RelationshipMetadata as OneToManyRelationshipMetadata;
            FabricRelationshipResolution resolved;
            if (relationship != null)
            {
                if (string.Equals(
                    relationship.ReferencedEntity,
                    profileEntity,
                    StringComparison.OrdinalIgnoreCase))
                {
                    resolved = new FabricRelationshipResolution(
                        relationship.ReferencingEntity,
                        relationship.ReferencedAttribute,
                        relationship.ReferencingAttribute);
                }
                else if (string.Equals(
                    relationship.ReferencingEntity,
                    profileEntity,
                    StringComparison.OrdinalIgnoreCase))
                {
                    resolved = new FabricRelationshipResolution(
                        relationship.ReferencedEntity,
                        relationship.ReferencingAttribute,
                        relationship.ReferencedAttribute);
                }
                else
                {
                    throw new InvalidPluginExecutionException(
                        "The relationship '" + relationshipSchema +
                        "' does not belong to the PROFILE entity " + profileEntity + ".");
                }

                relationshipCache.Add(cacheKey, resolved);
                StoreShared(
                    SharedRelationshipCache,
                    sharedKey,
                    resolved,
                    MaximumMetadataCacheEntries,
                    MetadataCacheTtl);
                return resolved;
            }

            var manyToMany =
                response.RelationshipMetadata as ManyToManyRelationshipMetadata;
            if (manyToMany == null)
            {
                throw new InvalidPluginExecutionException(
                    "The relationship '" + relationshipSchema +
                    "' is not a supported 1:N or N:N relationship.");
            }

            if (string.Equals(
                manyToMany.Entity1LogicalName,
                profileEntity,
                StringComparison.OrdinalIgnoreCase))
            {
                resolved = new FabricRelationshipResolution(
                    manyToMany.Entity2LogicalName,
                    ResolvePrimaryId(manyToMany.Entity1LogicalName),
                    ResolvePrimaryId(manyToMany.Entity2LogicalName),
                    manyToMany.IntersectEntityName,
                    manyToMany.Entity1IntersectAttribute,
                    manyToMany.Entity2IntersectAttribute);
            }
            else if (string.Equals(
                manyToMany.Entity2LogicalName,
                profileEntity,
                StringComparison.OrdinalIgnoreCase))
            {
                resolved = new FabricRelationshipResolution(
                    manyToMany.Entity1LogicalName,
                    ResolvePrimaryId(manyToMany.Entity2LogicalName),
                    ResolvePrimaryId(manyToMany.Entity1LogicalName),
                    manyToMany.IntersectEntityName,
                    manyToMany.Entity2IntersectAttribute,
                    manyToMany.Entity1IntersectAttribute);
            }
            else
            {
                throw new InvalidPluginExecutionException(
                    "The relationship '" + relationshipSchema +
                    "' does not belong to the PROFILE entity " + profileEntity + ".");
            }

            relationshipCache.Add(cacheKey, resolved);
            StoreShared(
                SharedRelationshipCache,
                sharedKey,
                resolved,
                MaximumMetadataCacheEntries,
                MetadataCacheTtl);
            return resolved;
        }

        private string ResolvePrimaryId(string entityName)
        {
            string primaryId;
            if (primaryIdCache.TryGetValue(entityName, out primaryId))
            {
                return primaryId;
            }

            var sharedKey = organizationId.ToString("D") + "|" + entityName;
            if (TryGetShared(SharedPrimaryIdCache, sharedKey, out primaryId))
            {
                primaryIdCache.Add(entityName, primaryId);
                return primaryId;
            }

            var metadataTimer = Stopwatch.StartNew();
            var response = (RetrieveEntityResponse)service.Execute(
                new RetrieveEntityRequest
                {
                    LogicalName = entityName,
                    EntityFilters = EntityFilters.Entity,
                    RetrieveAsIfPublished = true
                });
            Timings.EntityMetadata += metadataTimer.Elapsed.TotalMilliseconds;
            primaryId = response.EntityMetadata.PrimaryIdAttribute;
            if (string.IsNullOrWhiteSpace(primaryId))
            {
                throw new InvalidPluginExecutionException(
                    "The primary ID attribute for entity '" + entityName +
                    "' could not be determined.");
            }

            primaryIdCache.Add(entityName, primaryId);
            StoreShared(
                SharedPrimaryIdCache,
                sharedKey,
                primaryId,
                MaximumMetadataCacheEntries,
                MetadataCacheTtl);
            return primaryId;
        }

        private static FabricSegmentConditionRequest ConvertCondition(
            ConditionNode condition,
            bool allowConsent)
        {
            if (condition == null)
            {
                return null;
            }

            var and = condition as AndCondition;
            if (and != null)
            {
                return new FabricSegmentConditionRequest
                {
                    Kind = "and",
                    Children = and.Children
                        .Select(child => ConvertCondition(child, allowConsent))
                        .ToList()
                };
            }

            var or = condition as OrCondition;
            if (or != null)
            {
                return new FabricSegmentConditionRequest
                {
                    Kind = "or",
                    Children = or.Children
                        .Select(child => ConvertCondition(child, allowConsent))
                        .ToList()
                };
            }

            var not = condition as NotCondition;
            if (not != null)
            {
                return new FabricSegmentConditionRequest
                {
                    Kind = "not",
                    Children = new List<FabricSegmentConditionRequest>
                    {
                        ConvertCondition(not.Inner, allowConsent)
                    }
                };
            }

            var predicate = condition as PredicateCondition;
            if (predicate == null)
            {
                throw new InvalidPluginExecutionException(
                    "The segment definition contains an unknown condition.");
            }

            if (allowConsent && IsConsentPseudoField(predicate.Field.Name))
            {
                var consent = ConsentToken.Parse(predicate);
                return new FabricSegmentConditionRequest
                {
                    Kind = "consent",
                    ProfileEmailField = consent.EmailAttribute,
                    PurposeId = consent.PurposeId,
                    TopicId = consent.TopicId,
                    Channel = consent.Channel,
                    Value = string.IsNullOrEmpty(consent.Value)
                        ? null
                        : consent.Value
                };
            }

            var converted = new FabricSegmentConditionRequest
            {
                Kind = "predicate",
                Field = predicate.Field.Name,
                Qualifier = predicate.Field.Qualifier,
                Operator = ResolveOperator(predicate.Operator)
            };
            if (predicate.Operator == PredicateOperator.In)
            {
                converted.Values = predicate.Values
                    .Select(value => value.Value)
                    .ToList();
            }
            else if (predicate.Operator != PredicateOperator.IsNull &&
                predicate.Operator != PredicateOperator.IsNotNull &&
                predicate.Values.Count > 0)
            {
                converted.Value = predicate.Values[0].Value;
            }

            return converted;
        }

        private HashSet<Guid> RetrieveStaticSegmentIds(
            Guid segmentId,
            string groupsJson,
            string segmentName)
        {
            var timer = Stopwatch.StartNew();
            try
            {
            if (string.IsNullOrWhiteSpace(groupsJson))
            {
                throw new InvalidPluginExecutionException(
                    "The referenced segment '" +
                    (string.IsNullOrWhiteSpace(segmentName)
                        ? segmentId.ToString("D")
                        : segmentName) +
                    "' exposes neither an MQL definition nor static member groups. " +
                    "Its evaluated membership is stored outside Dataverse and cannot be " +
                    "recomputed by Segment Preview.");
            }

            var result = new HashSet<Guid>();
            var groups = Regex.Matches(
                groupsJson,
                "\\\"groupId\\\"\\s*:\\s*\\\"(?<id>[0-9a-fA-F-]{36})\\\".*?" +
                "\\\"includeType\\\"\\s*:\\s*\\\"(?<type>Include|Exclude)\\\"",
                RegexOptions.IgnoreCase);
            if (groups.Count == 0)
            {
                throw new InvalidPluginExecutionException(
                    "The static member groups could not be read.");
            }

            foreach (Match group in groups)
            {
                var groupIds = RetrieveStaticGroupIds(
                    segmentId,
                    Guid.Parse(group.Groups["id"].Value));
                if (string.Equals(
                    group.Groups["type"].Value,
                    "Include",
                    StringComparison.OrdinalIgnoreCase))
                {
                    result.UnionWith(groupIds);
                }
                else
                {
                    result.ExceptWith(groupIds);
                }
            }

                return result;
            }
            finally
            {
                Timings.StaticMembers += timer.Elapsed.TotalMilliseconds;
            }
        }

        private HashSet<Guid> RetrieveStaticGroupIds(Guid segmentId, Guid groupId)
        {
            var ids = new HashSet<Guid>();
            for (var pageNumber = 1; ; pageNumber++)
            {
                var request = new OrganizationRequest("msdynmkt_ListGroupMembers");
                request["SegmentId"] = segmentId.ToString("D");
                request["GroupId"] = groupId.ToString("D");
                request["PageNo"] = pageNumber;
                request["PageSize"] = StaticPageSize;
                var response = service.Execute(request);
                var responseJson = response.Results.Contains("Response")
                    ? response.Results["Response"] as string
                    : null;
                if (string.IsNullOrWhiteSpace(responseJson))
                {
                    throw new InvalidPluginExecutionException(
                        "The static segment members could not be read.");
                }

                var pageIds = Regex.Matches(
                    responseJson,
                    "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");
                foreach (Match pageId in pageIds)
                {
                    ids.Add(Guid.Parse(pageId.Value));
                }

                if (pageIds.Count < StaticPageSize)
                {
                    return ids;
                }
            }
        }

        private static IList<ConditionNode> FlattenAnd(ConditionNode condition)
        {
            var result = new List<ConditionNode>();
            FlattenAnd(condition, result);
            return result;
        }

        private static void FlattenAnd(
            ConditionNode condition,
            IList<ConditionNode> result)
        {
            var and = condition as AndCondition;
            if (and == null)
            {
                result.Add(condition);
                return;
            }

            foreach (var child in and.Children)
            {
                FlattenAnd(child, result);
            }
        }

        private static bool IsConsentPseudoField(string fieldName)
        {
            return fieldName.StartsWith(
                       "consent_topic_",
                       StringComparison.OrdinalIgnoreCase) ||
                   fieldName.StartsWith(
                       "consent_purpose_",
                       StringComparison.OrdinalIgnoreCase) ||
                   fieldName.StartsWith(
                       "compliance_profile_",
                       StringComparison.OrdinalIgnoreCase);
        }

        private static string ResolveOperator(PredicateOperator value)
        {
            switch (value)
            {
                case PredicateOperator.IsNull:
                    return "ISNULL";
                case PredicateOperator.IsNotNull:
                    return "ISNOTNULL";
                case PredicateOperator.Equal:
                    return "==";
                case PredicateOperator.NotEqual:
                    return "!=";
                case PredicateOperator.GreaterThan:
                    return ">";
                case PredicateOperator.GreaterOrEqual:
                    return ">=";
                case PredicateOperator.LessThan:
                    return "<";
                case PredicateOperator.LessOrEqual:
                    return "<=";
                case PredicateOperator.In:
                    return "IN";
                case PredicateOperator.Contains:
                    return "CONTAINS";
                default:
                    throw new InvalidPluginExecutionException(
                        "The comparison operator is not supported by Fabric.");
            }
        }

        private static string DescribeSetOperand(SegmentOperand operand)
        {
            var profile = operand as ProfileOperand;
            if (profile == null)
            {
                return operand.Describe();
            }

            var filters = new List<string>();
            foreach (var step in profile.FilterSteps)
            {
                var profileFilter = step as ProfileFilterStep;
                if (profileFilter != null)
                {
                    filters.Add(profileFilter.Condition.Describe());
                    continue;
                }

                var relationship = step as RelationshipFilterStep;
                if (relationship != null)
                {
                    filters.Add(
                        relationship.RelationshipSchema + ": " +
                        relationship.Condition.Describe());
                }
            }

            return filters.Count == 0
                ? profile.Describe()
                : string.Join(" AND ", filters.ToArray());
        }

        private string BuildRequestCacheKey(
            Guid segmentDefinitionId,
            DateTime? modifiedOn,
            bool businessUnitScopingEnabled)
        {
            return organizationId.ToString("D") + "|" +
                segmentDefinitionId.ToString("D") + "|" +
                (modifiedOn.HasValue
                    ? modifiedOn.Value.ToUniversalTime().Ticks.ToString()
                    : "unknown") + "|" +
                (businessUnitScopingEnabled ? "1" : "0");
        }

        private static bool TryGetRequest(
            string key,
            out FabricSegmentCountApiRequest request)
        {
            string serialized;
            if (TryGetShared(SharedRequestCache, key, out serialized))
            {
                request = FabricSegmentCountJsonSerialization
                    .Deserialize<FabricSegmentCountApiRequest>(serialized);
                return true;
            }

            request = null;
            return false;
        }

        private static void StoreRequest(
            string key,
            FabricSegmentCountApiRequest request)
        {
            StoreShared(
                SharedRequestCache,
                key,
                FabricSegmentCountJsonSerialization.Serialize(request),
                MaximumRequestCacheEntries,
                RequestCacheTtl);
        }

        private static bool ContainsStaticMembers(FabricSegmentQueryRequest query)
        {
            if (query == null)
            {
                return false;
            }

            if (ContainsStaticMembers(query.FirstOperand))
            {
                return true;
            }

            return (query.SetOperations ?? new List<FabricSegmentSetOperationRequest>())
                .Any(operation => ContainsStaticMembers(operation.Operand));
        }

        private static bool ContainsStaticMembers(FabricSegmentOperandRequest operand)
        {
            return operand != null &&
                ((operand.ProfileIds != null && operand.ProfileIds.Count > 0) ||
                 ContainsStaticMembers(operand.Query));
        }

        private static bool TryGetShared<T>(
            IDictionary<string, CacheEntry<T>> cache,
            string key,
            out T value)
        {
            lock (SharedCacheLock)
            {
                CacheEntry<T> entry;
                if (cache.TryGetValue(key, out entry))
                {
                    if (entry.ExpiresAtUtc > DateTime.UtcNow)
                    {
                        value = entry.Value;
                        return true;
                    }

                    cache.Remove(key);
                }
            }

            value = default(T);
            return false;
        }

        private static void StoreShared<T>(
            IDictionary<string, CacheEntry<T>> cache,
            string key,
            T value,
            int maximumEntries,
            TimeSpan ttl)
        {
            lock (SharedCacheLock)
            {
                var now = DateTime.UtcNow;
                foreach (var expired in cache
                    .Where(pair => pair.Value.ExpiresAtUtc <= now)
                    .Select(pair => pair.Key)
                    .ToList())
                {
                    cache.Remove(expired);
                }

                while (cache.Count >= maximumEntries)
                {
                    cache.Remove(cache.Keys.First());
                }

                cache[key] = new CacheEntry<T>(value, now.Add(ttl));
            }
        }

        private sealed class CacheEntry<T>
        {
            public CacheEntry(T value, DateTime expiresAtUtc)
            {
                Value = value;
                ExpiresAtUtc = expiresAtUtc;
            }

            public T Value { get; private set; }

            public DateTime ExpiresAtUtc { get; private set; }
        }

        private sealed class FabricRelationshipResolution
        {
            public FabricRelationshipResolution(
                string relatedEntity,
                string profileAttribute,
                string relatedAttribute,
                string intersectEntity = null,
                string sourceIntersectAttribute = null,
                string relatedIntersectAttribute = null)
            {
                RelatedEntity = relatedEntity;
                ProfileAttribute = profileAttribute;
                RelatedAttribute = relatedAttribute;
                IntersectEntity = intersectEntity;
                SourceIntersectAttribute = sourceIntersectAttribute;
                RelatedIntersectAttribute = relatedIntersectAttribute;
            }

            public string RelatedEntity { get; private set; }

            public string ProfileAttribute { get; private set; }

            public string RelatedAttribute { get; private set; }

            public string IntersectEntity { get; private set; }

            public string SourceIntersectAttribute { get; private set; }

            public string RelatedIntersectAttribute { get; private set; }
        }
    }

    internal sealed class FabricSegmentRequestBuildTimings
    {
        public double SegmentRetrieve { get; set; }

        public double MqlParsing { get; set; }

        public double RelationshipMetadata { get; set; }

        public double EntityMetadata { get; set; }

        public double SegmentReferences { get; set; }

        public double StaticMembers { get; set; }

        public string Cache { get; set; } = "miss";
    }
}
