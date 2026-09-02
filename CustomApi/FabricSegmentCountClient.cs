using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentCountClient
    {
        private const string ApiUrlVariable = "klth_FabricBehavioralApiUrl";
        private const string ApiKeyVariable = "klth_FabricBehavioralApiKey";
        private const string BusinessUnitScopingVariable =
            "klth_BusinessUnitScopingEnabled";
        private static readonly HttpClient HttpClient = CreateHttpClient();
        private readonly IOrganizationService service;
        private readonly ITracingService tracing;

        public FabricSegmentCountClient(
            IOrganizationService service,
            ITracingService tracing)
        {
            this.service = service;
            this.tracing = tracing;
        }

        public FilterCountResult Evaluate(Guid segmentDefinitionId)
        {
            var settings = EnvironmentVariableReader.ReadMany(
                service,
                new[]
                {
                    ApiUrlVariable,
                    ApiKeyVariable,
                    BusinessUnitScopingVariable
                },
                new[] { ApiUrlVariable, ApiKeyVariable });
            var apiUrl = settings[ApiUrlVariable];
            Uri behavioralEndpoint;
            if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out behavioralEndpoint) ||
                behavioralEndpoint.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidPluginExecutionException(
                    "The environment variable " + ApiUrlVariable +
                    " must contain an absolute HTTPS URL.");
            }

            var endpoint = new Uri(behavioralEndpoint, "segment-counts");
            var requestPayload = new FabricSegmentRequestBuilder(service)
                .Build(
                    segmentDefinitionId,
                    ReadBusinessUnitScopingEnabled(
                        settings[BusinessUnitScopingVariable]));
            var dependencies = new FabricTableDependencyResolver(service, tracing)
                .Resolve(requestPayload);
            requestPayload.RequiredDataverseTables =
                dependencies.RequiredTables.ToList();
            using (var request = new HttpRequestMessage(HttpMethod.Post, endpoint))
            {
                request.Headers.Add(
                    "x-api-key",
                    settings[ApiKeyVariable]);
                request.Content = new StringContent(
                    Serialize(requestPayload),
                    Encoding.UTF8,
                    "application/json");
                tracing.Trace(
                    "Calling full Fabric segment API for definition {0}.",
                    segmentDefinitionId);
                using (var response = HttpClient.SendAsync(request).GetAwaiter().GetResult())
                {
                    var responseBody = response.Content.ReadAsStringAsync()
                        .GetAwaiter()
                        .GetResult();
                    if (!response.IsSuccessStatusCode)
                    {
                        var apiError = TryDeserialize<FabricSegmentApiError>(responseBody);
                        var message = apiError != null &&
                            !string.IsNullOrWhiteSpace(apiError.Message)
                                ? apiError.Message
                                : "The full Fabric segment evaluation responded with HTTP " +
                                  ((int)response.StatusCode).ToString() + ".";
                        if (apiError != null && !string.IsNullOrWhiteSpace(apiError.Detail))
                        {
                            message += " " + apiError.Detail;
                        }

                        throw new InvalidPluginExecutionException(message);
                    }

                    var result = Deserialize<FabricSegmentCountApiResponse>(responseBody);
                    if (!result.CatalogReady)
                    {
                        throw new InvalidPluginExecutionException(
                            "The deployed Fabric API is older than the installed Segment Preview " +
                            "solution and does not support optimized dependency repair. Open Setup " +
                            "Center and run Install everything to update the API, then retry.");
                    }

                    dependencies.SetAddedTables(
                        result.AddedTables ?? new List<string>());
                    if (result.Stages == null || result.Stages.Count == 0)
                    {
                        throw new InvalidPluginExecutionException(
                            "The Fabric segment evaluation returned no count stages.");
                    }

                    DateTime generatedAt;
                    if (!DateTime.TryParse(
                        result.GeneratedAt,
                        null,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out generatedAt))
                    {
                        throw new InvalidPluginExecutionException(
                            "The Fabric segment evaluation returned an invalid timestamp.");
                    }

                    var stages = result.Stages
                        .OrderBy(stage => stage.Order)
                        .Select(stage => new FilterCountStage(
                            stage.Order,
                            stage.Label,
                            stage.Detail,
                            stage.Count))
                        .ToList();
                    tracing.Trace(
                        "Full Fabric segment API returned {0} stages.",
                        stages.Count);
                    return new FilterCountResult(
                        generatedAt,
                        false,
                        stages,
                        dependencies,
                        result.QueryToken);
                }
            }
        }

        private static bool ReadBusinessUnitScopingEnabled(string value)
        {
            if (value == null ||
                string.Equals(value, "false", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            throw new InvalidPluginExecutionException(
                "The environment variable " + BusinessUnitScopingVariable +
                " must contain true or false.");
        }

        private static string Serialize<T>(T value)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, value);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        private static T Deserialize<T>(string json)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            {
                return (T)serializer.ReadObject(stream);
            }
        }

        private static T TryDeserialize<T>(string json) where T : class
        {
            try
            {
                return Deserialize<T>(json);
            }
            catch (SerializationException)
            {
                return null;
            }
        }

        private static HttpClient CreateHttpClient()
        {
            return new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(180)
            };
        }
    }

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

    [DataContract]
    internal sealed class FabricSegmentCountApiRequest
    {
        [DataMember(Name = "query", Order = 1)]
        public FabricSegmentQueryRequest Query { get; set; }

        [DataMember(Name = "requiredDataverseTables", Order = 2)]
        public List<string> RequiredDataverseTables { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentQueryRequest
    {
        public FabricSegmentQueryRequest()
        {
            SetOperations = new List<FabricSegmentSetOperationRequest>();
        }

        [DataMember(Name = "firstOperand", Order = 1)]
        public FabricSegmentOperandRequest FirstOperand { get; set; }

        [DataMember(Name = "setOperations", Order = 2)]
        public List<FabricSegmentSetOperationRequest> SetOperations { get; set; }

        [DataMember(Name = "businessUnitId", Order = 3, EmitDefaultValue = false)]
        public Guid? BusinessUnitId { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentSetOperationRequest
    {
        [DataMember(Name = "operator", Order = 1)]
        public string Operator { get; set; }

        [DataMember(Name = "operand", Order = 2)]
        public FabricSegmentOperandRequest Operand { get; set; }

        [DataMember(Name = "label", Order = 3)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 4)]
        public string Detail { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentOperandRequest
    {
        public FabricSegmentOperandRequest()
        {
            Steps = new List<FabricSegmentFilterStepRequest>();
            ProfileIds = new List<Guid>();
        }

        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "profileEntity", Order = 2)]
        public string ProfileEntity { get; set; }

        [DataMember(Name = "baseLabel", Order = 3)]
        public string BaseLabel { get; set; }

        [DataMember(Name = "baseDetail", Order = 4)]
        public string BaseDetail { get; set; }

        [DataMember(Name = "steps", Order = 5)]
        public List<FabricSegmentFilterStepRequest> Steps { get; set; }

        [DataMember(Name = "eventLogicalName", Order = 6, EmitDefaultValue = false)]
        public string EventLogicalName { get; set; }

        [DataMember(Name = "entityIdField", Order = 7, EmitDefaultValue = false)]
        public string EntityIdField { get; set; }

        [DataMember(Name = "filter", Order = 8, EmitDefaultValue = false)]
        public FabricSegmentConditionRequest Filter { get; set; }

        [DataMember(Name = "having", Order = 9, EmitDefaultValue = false)]
        public FabricSegmentHavingRequest Having { get; set; }

        [DataMember(Name = "profileIds", Order = 10)]
        public List<Guid> ProfileIds { get; set; }

        [DataMember(Name = "query", Order = 11, EmitDefaultValue = false)]
        public FabricSegmentQueryRequest Query { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentFilterStepRequest
    {
        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "label", Order = 2)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }

        [DataMember(Name = "condition", Order = 4)]
        public FabricSegmentConditionRequest Condition { get; set; }

        [DataMember(Name = "relatedEntity", Order = 5, EmitDefaultValue = false)]
        public string RelatedEntity { get; set; }

        [DataMember(Name = "profileAttribute", Order = 6, EmitDefaultValue = false)]
        public string ProfileAttribute { get; set; }

        [DataMember(Name = "relatedAttribute", Order = 7, EmitDefaultValue = false)]
        public string RelatedAttribute { get; set; }

        [DataMember(Name = "isOptional", Order = 8)]
        public bool IsOptional { get; set; }

        [DataMember(Name = "relationships", Order = 9, EmitDefaultValue = false)]
        public List<FabricRelationshipHopRequest> Relationships { get; set; }
    }

    [DataContract]
    internal sealed class FabricRelationshipHopRequest
    {
        [DataMember(Name = "alias", Order = 1)]
        public string Alias { get; set; }

        [DataMember(Name = "relatedEntity", Order = 2)]
        public string RelatedEntity { get; set; }

        [DataMember(Name = "sourceAttribute", Order = 3, EmitDefaultValue = false)]
        public string SourceAttribute { get; set; }

        [DataMember(Name = "relatedAttribute", Order = 4, EmitDefaultValue = false)]
        public string RelatedAttribute { get; set; }

        [DataMember(Name = "isOptional", Order = 5)]
        public bool IsOptional { get; set; }

        [DataMember(Name = "intersectEntity", Order = 6, EmitDefaultValue = false)]
        public string IntersectEntity { get; set; }

        [DataMember(Name = "sourceIntersectAttribute", Order = 7, EmitDefaultValue = false)]
        public string SourceIntersectAttribute { get; set; }

        [DataMember(Name = "relatedIntersectAttribute", Order = 8, EmitDefaultValue = false)]
        public string RelatedIntersectAttribute { get; set; }

        [DataMember(Name = "sourcePrimaryAttribute", Order = 9, EmitDefaultValue = false)]
        public string SourcePrimaryAttribute { get; set; }

        [DataMember(Name = "relatedPrimaryAttribute", Order = 10, EmitDefaultValue = false)]
        public string RelatedPrimaryAttribute { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentConditionRequest
    {
        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "field", Order = 2, EmitDefaultValue = false)]
        public string Field { get; set; }

        [DataMember(Name = "qualifier", Order = 3, EmitDefaultValue = false)]
        public string Qualifier { get; set; }

        [DataMember(Name = "operator", Order = 4, EmitDefaultValue = false)]
        public string Operator { get; set; }

        [DataMember(Name = "value", Order = 5, EmitDefaultValue = false)]
        public object Value { get; set; }

        [DataMember(Name = "values", Order = 6, EmitDefaultValue = false)]
        public List<object> Values { get; set; }

        [DataMember(Name = "children", Order = 7, EmitDefaultValue = false)]
        public List<FabricSegmentConditionRequest> Children { get; set; }

        [DataMember(Name = "profileEmailField", Order = 8, EmitDefaultValue = false)]
        public string ProfileEmailField { get; set; }

        [DataMember(Name = "purposeId", Order = 9, EmitDefaultValue = false)]
        public Guid? PurposeId { get; set; }

        [DataMember(Name = "topicId", Order = 10, EmitDefaultValue = false)]
        public Guid? TopicId { get; set; }

        [DataMember(Name = "channel", Order = 11, EmitDefaultValue = false)]
        public string Channel { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentHavingRequest
    {
        [DataMember(Name = "metric", Order = 1)]
        public string Metric { get; set; }

        [DataMember(Name = "operator", Order = 2)]
        public string Operator { get; set; }

        [DataMember(Name = "threshold", Order = 3)]
        public long Threshold { get; set; }

        [DataMember(Name = "windowFunction", Order = 4, EmitDefaultValue = false)]
        public string WindowFunction { get; set; }

        [DataMember(Name = "windowValue", Order = 5, EmitDefaultValue = false)]
        public int? WindowValue { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentCountApiResponse
    {
        [DataMember(Name = "stages", Order = 1)]
        public List<FabricSegmentCountApiStage> Stages { get; set; }

        [DataMember(Name = "generatedAt", Order = 3)]
        public string GeneratedAt { get; set; }

        [DataMember(Name = "queryToken", Order = 4)]
        public string QueryToken { get; set; }

        [DataMember(Name = "addedTables", Order = 5)]
        public List<string> AddedTables { get; set; }

        [DataMember(Name = "catalogReady", Order = 6)]
        public bool CatalogReady { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentCountApiStage
    {
        [DataMember(Name = "order", Order = 1)]
        public int Order { get; set; }

        [DataMember(Name = "label", Order = 2)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }

        [DataMember(Name = "count", Order = 4)]
        public long Count { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentApiError
    {
        [DataMember(Name = "code", Order = 1)]
        public string Code { get; set; }

        [DataMember(Name = "message", Order = 2)]
        public string Message { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }
    }
}
