using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace CustomerInsightsSegmentSankey.CustomApi.Tests
{
    public sealed class PresentationDetailTests
    {
        [Fact]
        public void InteractionSetOperation_UsesReadableEventFrequencyAndPeriod()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact) INTERSECT " +
                        "Interaction(msdynmkt_emaildelivered, msdynmkt_entityid)" +
                        ".FILTER((msdynmkt_entityid_LogicalName == 'contact' AND " +
                        "ISNOTNULL(msdynmkt_messagetemplateid)))" +
                        ".Having(Count() >= 1, UTCMONTHS(24))",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var detail = BuildFirstSetOperationDetail(service, definitionId);

            Assert.Equal(
                "Email delivered\n" +
                "Scope: Contact interactions with a message template\n" +
                "Frequency: At least 1 occurrence\n" +
                "Period: Last 24 months",
                detail);
        }

        [Fact]
        public void SegmentUnion_UsesReferencedSegmentDisplayName()
        {
            var definitionId = Guid.NewGuid();
            var segmentId = Guid.NewGuid();
            var referencedDefinitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact) UNION SEGMENT(SEGMENT_CJO_ID_" +
                        segmentId.ToString("N") + ")",
                    ["modifiedon"] = DateTime.UtcNow
                },
                new Entity("msdynmkt_segment", segmentId)
                {
                    ["msdynmkt_sourcesegmentuid"] =
                        referencedDefinitionId.ToString("D"),
                    ["msdynmkt_baseentitylogicalname"] = "contact",
                    ["msdynmkt_displayname"] = "Newsletter 2026"
                },
                new Entity("msdynmkt_segmentdefinition", referencedDefinitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact).FILTER(ISNOTNULL(emailaddress1))",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var detail = BuildFirstSetOperationDetail(service, definitionId);

            Assert.Equal(
                "Newsletter 2026\nSource: Referenced segment",
                detail);
        }

        private static string BuildFirstSetOperationDetail(
            IOrganizationService service,
            Guid definitionId)
        {
            var assembly = typeof(
                CustomerInsightsSegmentSankey.CustomApi.GetSegmentFilterCountsPlugin)
                .Assembly;
            var builderType = assembly.GetType(
                "CustomerInsightsSegmentSankey.CustomApi.FabricSegmentRequestBuilder",
                true);
            var builder = Activator.CreateInstance(
                builderType,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null,
                new object[] { service, Guid.NewGuid() },
                null);
            var request = builderType.GetMethod("Build").Invoke(
                builder,
                new object[] { definitionId, false, false });
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operations = ((IEnumerable)query
                .GetType()
                .GetProperty("SetOperations")
                .GetValue(query))
                .Cast<object>()
                .ToList();

            Assert.Single(operations);
            return (string)operations[0]
                .GetType()
                .GetProperty("Detail")
                .GetValue(operations[0]);
        }

        private sealed class StubOrganizationService : IOrganizationService
        {
            private readonly Dictionary<string, Entity> entities;

            public StubOrganizationService(params Entity[] entities)
            {
                this.entities = entities.ToDictionary(
                    entity => entity.LogicalName + "|" + entity.Id.ToString("D"),
                    StringComparer.OrdinalIgnoreCase);
            }

            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
            {
                Entity entity;
                if (entities.TryGetValue(
                    entityName + "|" + id.ToString("D"),
                    out entity))
                {
                    return entity;
                }

                throw new InvalidOperationException(
                    "Unexpected retrieve: " + entityName + " " + id);
            }

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                throw new NotSupportedException();
            }

            public Guid Create(Entity entity) { throw new NotSupportedException(); }
            public void Update(Entity entity) { throw new NotSupportedException(); }
            public void Delete(string entityName, Guid id) { throw new NotSupportedException(); }
            public OrganizationResponse Execute(OrganizationRequest request)
            {
                throw new NotSupportedException();
            }
            public void Associate(
                string entityName,
                Guid entityId,
                Relationship relationship,
                EntityReferenceCollection relatedEntities)
            {
                throw new NotSupportedException();
            }
            public void Disassociate(
                string entityName,
                Guid entityId,
                Relationship relationship,
                EntityReferenceCollection relatedEntities)
            {
                throw new NotSupportedException();
            }
        }
    }
}
