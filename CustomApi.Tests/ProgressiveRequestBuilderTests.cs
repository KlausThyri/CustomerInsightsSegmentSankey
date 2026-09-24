using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace CustomerInsightsSegmentSankey.CustomApi.Tests
{
    public sealed class ProgressiveRequestBuilderTests
    {
        [Fact]
        public void Preview_DefersStaticReferenceMembersAndKeepsDynamicPrefix()
        {
            var rootDefinitionId = Guid.NewGuid();
            var referencedSegmentId = Guid.NewGuid();
            var referencedDefinitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                rootDefinitionId,
                referencedSegmentId,
                referencedDefinitionId);
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
                new object[] { rootDefinitionId, false, true });
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operations = (System.Collections.ICollection)query
                .GetType()
                .GetProperty("SetOperations")
                .GetValue(query);
            var deferred = ((System.Collections.IEnumerable)builderType
                .GetProperty("DeferredStages")
                .GetValue(builder))
                .Cast<object>()
                .ToList();
            var timings = builderType.GetProperty("Timings").GetValue(builder);
            var staticMembers = (double)timings
                .GetType()
                .GetProperty("StaticMembers")
                .GetValue(timings);

            Assert.Empty(operations);
            Assert.Single(deferred);
            Assert.Equal("Union", deferred[0].GetType().GetProperty("Label").GetValue(deferred[0]));
            Assert.Equal(0, staticMembers);
            Assert.Equal(0, service.StaticMemberQueries);
        }

        private sealed class StubOrganizationService : IOrganizationService
        {
            private readonly Guid rootDefinitionId;
            private readonly Guid referencedSegmentId;
            private readonly Guid referencedDefinitionId;

            public StubOrganizationService(
                Guid rootDefinitionId,
                Guid referencedSegmentId,
                Guid referencedDefinitionId)
            {
                this.rootDefinitionId = rootDefinitionId;
                this.referencedSegmentId = referencedSegmentId;
                this.referencedDefinitionId = referencedDefinitionId;
            }

            public int StaticMemberQueries { get; private set; }

            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
            {
                if (entityName == "msdynmkt_segmentdefinition" &&
                    id == rootDefinitionId)
                {
                    return new Entity(entityName, id)
                    {
                        ["msdynmkt_segmentquery"] =
                            "PROFILE(contact).FILTER(ISNOTNULL(emailaddress1)) " +
                            "UNION SEGMENT(SEGMENT_CJO_ID_" +
                            referencedSegmentId.ToString("N") + ")",
                        ["modifiedon"] = DateTime.UtcNow
                    };
                }

                if (entityName == "msdynmkt_segment" &&
                    id == referencedSegmentId)
                {
                    return new Entity(entityName, id)
                    {
                        ["msdynmkt_sourcesegmentuid"] =
                            referencedDefinitionId.ToString("D"),
                        ["msdynmkt_baseentitylogicalname"] = "contact",
                        ["msdynmkt_displayname"] = "Static reference"
                    };
                }

                if (entityName == "msdynmkt_segmentdefinition" &&
                    id == referencedDefinitionId)
                {
                    return new Entity(entityName, id)
                    {
                        ["msdynmkt_staticlistmembers"] = "[]",
                        ["modifiedon"] = DateTime.UtcNow
                    };
                }

                throw new InvalidOperationException(
                    "Unexpected retrieve: " + entityName + " " + id);
            }

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                StaticMemberQueries++;
                throw new InvalidOperationException(
                    "Static members must not be queried during preview.");
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
