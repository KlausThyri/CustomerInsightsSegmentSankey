using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricTableDependencyResolver
    {
        private const string SegmentEntityName = "msdynmkt_segmentdefinition";
        private const string SegmentQueryAttribute = "msdynmkt_segmentquery";
        private const string ConsentEntityName = "msdynmkt_contactpointconsent4";
        private const int MaximumAutoAddedTables = 20;

        private readonly IOrganizationService service;
        private readonly ITracingService tracing;

        public FabricTableDependencyResolver(
            IOrganizationService service,
            ITracingService tracing)
        {
            this.service = service;
            this.tracing = tracing;
        }

        public FabricDependencyStatus Resolve(Guid segmentDefinitionId)
        {
            var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var events = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var recursionPath = new HashSet<Guid>();
            ResolveSegment(segmentDefinitionId, tables, events, recursionPath);

            var orderedTables = tables.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToList();
            var link = RetrieveActiveFabricLink();
            return new FabricDependencyStatus(
                link.Name,
                orderedTables,
                new List<string>(),
                events.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToList());
        }

        private FabricLinkDescriptor RetrieveActiveFabricLink()
        {
            var query = new QueryExpression("synapselinkprofile")
            {
                ColumnSet = new ColumnSet(
                    "name",
                    "extendedproperties",
                    "datalakefolder"),
                NoLock = true
            };
            query.Criteria.AddCondition("statecode", ConditionOperator.Equal, 0);
            query.Criteria.AddCondition("profiletype", ConditionOperator.Equal, 0);
            query.Orders.Add(new OrderExpression("modifiedon", OrderType.Descending));

            foreach (var profile in service.RetrieveMultiple(query).Entities)
            {
                var properties = profile.GetAttributeValue<string>("extendedproperties");
                if (string.IsNullOrEmpty(properties) ||
                    properties.IndexOf(
                        "\"LinkedToFabric\":true",
                        StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                return new FabricLinkDescriptor(
                    profile.Id,
                    profile.GetAttributeValue<string>("name") ?? profile.Id.ToString("D"));
            }

            throw new InvalidPluginExecutionException(
                "No active Dataverse link connected to Fabric was found.");
        }

        private sealed class FabricLinkDescriptor
        {
            public FabricLinkDescriptor(Guid id, string name)
            {
                Id = id;
                Name = name;
            }

            public Guid Id { get; private set; }

            public string Name { get; private set; }
        }

        private void ResolveSegment(
            Guid segmentDefinitionId,
            ISet<string> tables,
            ISet<string> events,
            ISet<Guid> recursionPath)
        {
            if (!recursionPath.Add(segmentDefinitionId))
            {
                throw new InvalidPluginExecutionException(
                    "The segment references contain a cycle at " +
                    segmentDefinitionId.ToString("D") + ".");
            }

            try
            {
                var definition = service.Retrieve(
                    SegmentEntityName,
                    segmentDefinitionId,
                    new ColumnSet(SegmentQueryAttribute));
                var mql = definition.GetAttributeValue<string>(SegmentQueryAttribute);
                if (string.IsNullOrWhiteSpace(mql))
                {
                    throw new InvalidPluginExecutionException(
                        "The segment definition " + segmentDefinitionId.ToString("D") +
                        " does not contain an MQL query.");
                }

                ResolveQuery(
                    new MqlParser(mql).Parse(),
                    tables,
                    events,
                    recursionPath);
            }
            finally
            {
                recursionPath.Remove(segmentDefinitionId);
            }
        }

        private void ResolveQuery(
            SegmentQuery query,
            ISet<string> tables,
            ISet<string> events,
            ISet<Guid> recursionPath)
        {
            ResolveOperand(query.FirstOperand, tables, events, recursionPath);
            foreach (var operation in query.SetOperations)
            {
                ResolveOperand(operation.Operand, tables, events, recursionPath);
            }
        }

        private void ResolveOperand(
            SegmentOperand operand,
            ISet<string> tables,
            ISet<string> events,
            ISet<Guid> recursionPath)
        {
            var profile = operand as ProfileOperand;
            if (profile != null)
            {
                tables.Add(profile.EntityName);
                foreach (var step in profile.FilterSteps)
                {
                    var profileFilter = step as ProfileFilterStep;
                    if (profileFilter != null)
                    {
                        if (ContainsConsentToken(profileFilter.Condition))
                        {
                            tables.Add(ConsentEntityName);
                        }

                        continue;
                    }

                    var relationship = step as RelationshipFilterStep;
                    if (relationship != null)
                    {
                        AddRelationshipTables(
                            profile.EntityName,
                            relationship.RelationshipSchema,
                            tables);
                        if (ContainsConsentToken(relationship.Condition))
                        {
                            tables.Add(ConsentEntityName);
                        }
                    }
                }

                return;
            }

            var interaction = operand as InteractionOperand;
            if (interaction != null)
            {
                tables.Add(interaction.ResolveProfileEntity());
                events.Add(interaction.EventLogicalName);
                return;
            }

            var segmentReference = operand as SegmentReferenceOperand;
            if (segmentReference != null)
            {
                ResolveSegmentReference(
                    segmentReference.SegmentId,
                    tables,
                    events,
                    recursionPath);
                return;
            }

            throw new InvalidPluginExecutionException(
                "The segment definition contains an unknown operand.");
        }

        private void ResolveSegmentReference(
            Guid segmentId,
            ISet<string> tables,
            ISet<string> events,
            ISet<Guid> recursionPath)
        {
            var segment = service.Retrieve(
                "msdynmkt_segment",
                segmentId,
                new ColumnSet(
                    "msdynmkt_sourcesegmentuid",
                    "msdynmkt_baseentitylogicalname"));
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
                new ColumnSet(SegmentQueryAttribute));
            var mql = definition.GetAttributeValue<string>(SegmentQueryAttribute);
            if (!string.IsNullOrWhiteSpace(mql))
            {
                ResolveSegment(definitionId, tables, events, recursionPath);
                return;
            }

            var profileName =
                segment.GetAttributeValue<string>("msdynmkt_baseentitylogicalname");
            tables.Add(
                string.IsNullOrWhiteSpace(profileName)
                    ? "contact"
                    : profileName);
        }

        private void AddRelationshipTables(
            string profileEntity,
            string relationshipSchema,
            ISet<string> tables)
        {
            var response = (RetrieveRelationshipResponse)service.Execute(
                new RetrieveRelationshipRequest
                {
                    Name = relationshipSchema,
                    RetrieveAsIfPublished = true
                });
            var relationship = response.RelationshipMetadata as OneToManyRelationshipMetadata;
            if (relationship == null)
            {
                throw new InvalidPluginExecutionException(
                    "The relationship '" + relationshipSchema +
                    "' is not a supported 1:N relationship.");
            }

            if (!string.Equals(
                    relationship.ReferencedEntity,
                    profileEntity,
                    StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(
                    relationship.ReferencingEntity,
                    profileEntity,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidPluginExecutionException(
                    "The relationship '" + relationshipSchema +
                    "' does not belong to the PROFILE entity " + profileEntity + ".");
            }

            tables.Add(relationship.ReferencedEntity);
            tables.Add(relationship.ReferencingEntity);
        }

        private static bool ContainsConsentToken(ConditionNode condition)
        {
            if (condition == null)
            {
                return false;
            }

            var predicate = condition as PredicateCondition;
            if (predicate != null)
            {
                if (ContainsConsentToken(predicate.Field.Name))
                {
                    return true;
                }

                return predicate.Values.Any(
                    value => ContainsConsentToken(value.Value as string));
            }

            var not = condition as NotCondition;
            if (not != null)
            {
                return ContainsConsentToken(not.Inner);
            }

            var and = condition as AndCondition;
            if (and != null)
            {
                return and.Children.Any(ContainsConsentToken);
            }

            var or = condition as OrCondition;
            return or != null && or.Children.Any(ContainsConsentToken);
        }

        private static bool ContainsConsentToken(string value)
        {
            return !string.IsNullOrEmpty(value) &&
                value.IndexOf("cp:", StringComparison.OrdinalIgnoreCase) >= 0;
        }

    }
}
