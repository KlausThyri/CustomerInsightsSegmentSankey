using System;
using System.Collections.Generic;
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
        private readonly IOrganizationService service;
        private readonly Dictionary<string, FabricRelationshipResolution> relationshipCache;
        private readonly Dictionary<string, string> primaryIdCache;

        public FabricSegmentRequestBuilder(IOrganizationService service)
        {
            this.service = service;
            relationshipCache =
                new Dictionary<string, FabricRelationshipResolution>(
                    StringComparer.OrdinalIgnoreCase);
            primaryIdCache =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

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
                var businessUnit = definition.GetAttributeValue<EntityReference>(
                    "owningbusinessunit");
                if (businessUnitScopingEnabled && businessUnit == null)
                {
                    throw new InvalidPluginExecutionException(
                        "Business-unit scoping is enabled, but the segment definition " +
                        segmentDefinitionId.ToString("D") +
                        " has no owning business unit.");
                }

                var query = BuildQuery(
                    new MqlParser(ReadSegmentQuery(definition)).Parse(),
                    recursionPath);
                query.BusinessUnitId = businessUnitScopingEnabled
                    ? (Guid?)businessUnit.Id
                    : null;
                return new FabricSegmentCountApiRequest { Query = query };
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
                return BuildQuery(
                    new MqlParser(ReadSegmentQuery(definition)).Parse(),
                    recursionPath);
            }
            finally
            {
                recursionPath.Remove(definitionId);
            }
        }

        private Entity RetrieveDefinition(Guid definitionId)
        {
            return service.Retrieve(
                SegmentEntityName,
                definitionId,
                new ColumnSet(SegmentQueryAttribute, "owningbusinessunit"));
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
            var segment = service.Retrieve(
                "msdynmkt_segment",
                segmentId,
                new ColumnSet(
                    "msdynmkt_sourcesegmentuid",
                    "msdynmkt_baseentitylogicalname",
                    "msdynmkt_displayname"));
            Guid definitionId;
            if (!Guid.TryParse(
                segment.GetAttributeValue<string>("msdynmkt_sourcesegmentuid"),
                out definitionId))
            {
                throw new InvalidPluginExecutionException(
                    "The referenced segment definition for " +
                    segmentId.ToString("D") + " could not be determined.");
            }

            var definition = service.Retrieve(
                SegmentEntityName,
                definitionId,
                new ColumnSet(SegmentQueryAttribute, "msdynmkt_staticlistmembers"));
            var mql = definition.GetAttributeValue<string>(SegmentQueryAttribute);
            var profileEntity =
                segment.GetAttributeValue<string>("msdynmkt_baseentitylogicalname");
            if (string.IsNullOrWhiteSpace(profileEntity))
            {
                profileEntity = "contact";
            }

            if (!string.IsNullOrWhiteSpace(mql))
            {
                var query = BuildDefinition(definitionId, recursionPath);
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

            return new FabricSegmentOperandRequest
            {
                Kind = "static",
                ProfileEntity = profileEntity,
                BaseLabel = "Static segment",
                BaseDetail = "SEGMENT(SEGMENT_CJO_ID_" +
                    segmentId.ToString("N") + ")",
                ProfileIds = RetrieveStaticSegmentIds(
                    segmentId,
                    definition.GetAttributeValue<string>("msdynmkt_staticlistmembers"),
                    segment.GetAttributeValue<string>("msdynmkt_displayname"))
                    .ToList()
            };
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

            var response = (RetrieveRelationshipResponse)service.Execute(
                new RetrieveRelationshipRequest
                {
                    Name = relationshipSchema,
                    RetrieveAsIfPublished = true
                });
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
            return resolved;
        }

        private string ResolvePrimaryId(string entityName)
        {
            string primaryId;
            if (primaryIdCache.TryGetValue(entityName, out primaryId))
            {
                return primaryId;
            }

            var response = (RetrieveEntityResponse)service.Execute(
                new RetrieveEntityRequest
                {
                    LogicalName = entityName,
                    EntityFilters = EntityFilters.Entity,
                    RetrieveAsIfPublished = true
                });
            primaryId = response.EntityMetadata.PrimaryIdAttribute;
            if (string.IsNullOrWhiteSpace(primaryId))
            {
                throw new InvalidPluginExecutionException(
                    "The primary ID attribute for entity '" + entityName +
                    "' could not be determined.");
            }

            primaryIdCache.Add(entityName, primaryId);
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
}
