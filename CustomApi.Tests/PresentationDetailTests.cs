using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace CustomerInsightsSegmentSankey.CustomApi.Tests
{
    public sealed class PresentationDetailTests
    {
        [Theory]
        [InlineData(534120000)]
        [InlineData(534120001)]
        [InlineData(534120002)]
        public void EvaluatedConsent_ResolvesPurposeModelAndSerializesIt(int model)
        {
            var definition = ConsentDefinition("WillSend");
            var purpose = ConsentPurpose(model);
            var topic = ConsentTopic(purpose.Id);
            var request = BuildRequest(new StubOrganizationService(definition, purpose, topic),
                definition.Id);
            using (var stream = new System.IO.MemoryStream())
            {
                new System.Runtime.Serialization.Json.DataContractJsonSerializer(request.GetType())
                    .WriteObject(stream, request);
                var json = System.Text.Encoding.UTF8.GetString(stream.ToArray());
                Assert.Contains("\"enforcementModel\":" + model, json);
                Assert.Contains("\"value\":\"WillSend\"", json);
            }
        }

        [Theory]
        [InlineData(null, 0)]
        [InlineData(999, 0)]
        [InlineData(534120001, 1)]
        public void EvaluatedConsent_RejectsMissingUnknownOrInactivePurpose(int? model, int state)
        {
            var definition = ConsentDefinition("WillSend");
            var purpose = ConsentPurpose(model);
            purpose["statecode"] = new OptionSetValue(state);
            var error = Assert.Throws<TargetInvocationException>(() =>
                BuildRequest(new StubOrganizationService(definition, purpose), definition.Id));
            Assert.IsType<InvalidPluginExecutionException>(error.InnerException);
            Assert.Contains("unsupported Email enforcement model", error.InnerException.Message);
        }

        [Fact]
        public void EvaluatedConsent_RejectsTopicFromAnotherPurpose()
        {
            var definition = ConsentDefinition("WillNotSend");
            var purpose = ConsentPurpose(534120001);
            var error = Assert.Throws<TargetInvocationException>(() =>
                BuildRequest(new StubOrganizationService(definition, purpose,
                    ConsentTopic(Guid.NewGuid())), definition.Id));
            Assert.IsType<InvalidPluginExecutionException>(error.InnerException);
            Assert.Contains("does not belong", error.InnerException.Message);
        }

        private static Entity ConsentDefinition(string value) =>
            new Entity("msdynmkt_segmentdefinition", Guid.NewGuid())
            {
                ["msdynmkt_segmentquery"] =
                    "PROFILE(contact).FILTER(compliance_profile_example == " +
                    "'cp:ab3f8454-ac47-f111-bec7-6045bde0d602;" +
                    "p:444e8759-da21-f111-8341-6045bde0d602;ch:Email;ea:emailaddress1;" +
                    "t:03b9fc9a-da21-f111-8341-6045bde0d602;v:" + value + "')",
                ["modifiedon"] = DateTime.UtcNow
            };

        private static Entity ConsentPurpose(int? model)
        {
            var purpose = new Entity("msdynmkt_purpose",
                Guid.Parse("444e8759-da21-f111-8341-6045bde0d602"))
            {
                ["statecode"] = new OptionSetValue(0)
            };
            if (model.HasValue)
            {
                purpose["msdynmkt_enforcementmodel"] = new OptionSetValue(model.Value);
            }
            return purpose;
        }

        private static Entity ConsentTopic(Guid purpose) =>
            new Entity("msdynmkt_topic", Guid.Parse("03b9fc9a-da21-f111-8341-6045bde0d602"))
            {
                ["msdynmkt_purposeid"] = new EntityReference("msdynmkt_purpose", purpose),
                ["statecode"] = new OptionSetValue(0)
            };

        [Fact]
        public void SiblingRelationships_DiscoverDependenciesFromEveryBranch()
        {
            const string mql =
                "PROFILE(contact).RELATEOPTIONAL(order_customer_contacts, order_1)" +
                ".RELATEOPTIONAL(contact_accounts, account_1)" +
                ".FILTER(order_1.name == 'First' OR account_1.name == 'Second')";
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] = mql,
                    ["modifiedon"] = DateTime.UtcNow
                });
            var assembly = typeof(
                CustomerInsightsSegmentSankey.CustomApi.GetSegmentFilterCountsPlugin).Assembly;
            var resolverType = assembly.GetType(
                "CustomerInsightsSegmentSankey.CustomApi.FabricTableDependencyResolver", true);
            var resolver = Activator.CreateInstance(resolverType,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null, new object[] { service, null }, null);
            var parserType = assembly.GetType(
                "CustomerInsightsSegmentSankey.CustomApi.MqlParser", true);
            var parser = Activator.CreateInstance(parserType,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null, new object[] { mql }, null);
            var query = parserType.GetMethod("Parse").Invoke(parser, null);
            var operand = query.GetType().GetProperty("FirstOperand").GetValue(query);
            var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var events = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            resolverType.GetMethod("ResolveOperand", BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(resolver, new object[] { operand, tables, events, new HashSet<Guid>() });
            Assert.Equal(new[] { "account", "contact", "salesorder" }, tables.OrderBy(name => name));

            var request = BuildRequest(service, definitionId);
            var builtQuery = request.GetType().GetProperty("Query").GetValue(request);
            var builtOperand = builtQuery.GetType().GetProperty("FirstOperand").GetValue(builtQuery);
            tables.Clear();
            resolverType.GetMethod("ResolveBuiltOperand", BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, new object[] { builtOperand, tables, events });
            Assert.Equal(new[] { "account", "contact", "salesorder" }, tables.OrderBy(name => name));
        }

        [Fact]
        public void SiblingRelationships_PreserveSourceBindingsAndPresentationEntities()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact)" +
                        ".RELATEOPTIONAL(order_customer_contacts, order_1, RELATEOPTIONAL(order_details, detail_1))" +
                        ".RELATEOPTIONAL(order_customer_contacts, order_2)" +
                        ".FILTER(detail_1.name == 'First' AND order_2.name == 'Second' AND firstname == 'Ada')",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var request = BuildRequest(service, definitionId);
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operand = query.GetType().GetProperty("FirstOperand").GetValue(query);
            var steps = ((IEnumerable)operand.GetType().GetProperty("Steps").GetValue(operand))
                .Cast<object>().ToList();

            Assert.Equal(3, steps.Count);
            foreach (var step in steps)
            {
                var hops = ((IEnumerable)step.GetType().GetProperty("Relationships").GetValue(step))
                    .Cast<object>().ToList();
                Assert.Equal(3, hops.Count);
                Assert.Equal(new[] { "", "order_1", "" },
                    hops.Select(hop => (string)hop.GetType().GetProperty("SourceAlias").GetValue(hop)));
                Assert.Equal(new[] { "order_1", "detail_1", "order_2" },
                    hops.Select(hop => (string)hop.GetType().GetProperty("Alias").GetValue(hop)));
            }

            Assert.Equal(new[] { "salesorderdetail", "salesorder", "contact" },
                steps.Select(step =>
                {
                    var hint = step.GetType().GetProperty("Presentation").GetValue(step);
                    return (string)hint.GetType().GetProperty("Entity").GetValue(hint);
                }));
            using (var stream = new System.IO.MemoryStream())
            {
                var serializer = new System.Runtime.Serialization.Json.DataContractJsonSerializer(
                    request.GetType());
                serializer.WriteObject(stream, request);
                var json = System.Text.Encoding.UTF8.GetString(stream.ToArray());
                Assert.Contains("\"sourceAlias\":\"\"", json);
                Assert.Contains("\"sourceAlias\":\"order_1\"", json);
            }
        }

        [Fact]
        public void InteractionSetOperation_UsesReadableEventFrequencyAndPeriod()
        {
            var definitionId = Guid.NewGuid();
            var messageTemplateId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact) INTERSECT " +
                        "Interaction(msdynmkt_emaildelivered, msdynmkt_entityid)" +
                        ".FILTER((msdynmkt_entityid_LogicalName == 'contact' AND " +
                        "msdynmkt_messagetemplateid == '" +
                        messageTemplateId.ToString("D") + "'))" +
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

            var request = BuildRequest(service, definitionId);
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operation = ((IEnumerable)query
                .GetType()
                .GetProperty("SetOperations")
                .GetValue(query))
                .Cast<object>()
                .Single();
            var presentation = operation
                .GetType()
                .GetProperty("Presentation")
                .GetValue(operation);

            Assert.Equal(
                messageTemplateId,
                presentation.GetType()
                    .GetProperty("MessageTemplateId")
                    .GetValue(presentation));
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

        [Fact]
        public void ConsentProfileFilter_HidesTechnicalTokenIdentifiers()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact).FILTER(" +
                        "compliance_profile_06ba242267cf463d98c4e9aace82b774 ==" +
                        "'cp:ab3f8454-ac47-f111-bec7-6045bde0d602;" +
                        "p:51cc8a5a-ac47-f111-bec7-6045bde0d602;" +
                        "ch:Email;ea:emailaddress1;" +
                        "t:3d270eb3-ac47-f111-bec7-6045bde0d602;" +
                        "v:OptedIn')",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var detail = BuildFirstProfileStepDetail(service, definitionId);

            Assert.Equal(
                "Email consent\n" +
                "Status: Opted in\n" +
                "Contact point: Email address 1",
                detail);
            Assert.DoesNotContain("cp:", detail);
            Assert.DoesNotContain("06ba242267cf", detail);

            var request = BuildRequest(service, definitionId);
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operand = query.GetType().GetProperty("FirstOperand").GetValue(query);
            var step = ((IEnumerable)operand
                .GetType()
                .GetProperty("Steps")
                .GetValue(operand))
                .Cast<object>()
                .Single();
            var presentation = step
                .GetType()
                .GetProperty("Presentation")
                .GetValue(step);

            Assert.Equal(
                Guid.Parse("ab3f8454-ac47-f111-bec7-6045bde0d602"),
                presentation.GetType()
                    .GetProperty("ComplianceProfileId")
                    .GetValue(presentation));
            Assert.Equal(
                Guid.Parse("51cc8a5a-ac47-f111-bec7-6045bde0d602"),
                presentation.GetType()
                    .GetProperty("PurposeId")
                    .GetValue(presentation));
            Assert.Equal(
                Guid.Parse("3d270eb3-ac47-f111-bec7-6045bde0d602"),
                presentation.GetType()
                    .GetProperty("TopicId")
                    .GetValue(presentation));
        }

        [Fact]
        public void ProfileIntersection_UsesReadableFieldAndOperator()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact) INTERSECT PROFILE(contact)" +
                        ".FILTER(klth_risikoprofil IN [700370003, 700370004])",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var detail = BuildFirstSetOperationDetail(service, definitionId);

            Assert.Equal(
                "Risikoprofil\n" +
                "Condition: Risikoprofil is one of 700370003, 700370004",
                detail);
        }

        [Fact]
        public void RelationshipExclusion_UsesReadableRelationshipAndNegation()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact) EXCEPT PROFILE(contact)" +
                        ".RELATE(order_customer_contacts, salesorder_1)" +
                        ".FILTER(NOT(salesorder_1.name CONTAINS 'Depot'))",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var detail = BuildFirstSetOperationDetail(service, definitionId);

            Assert.Equal(
                "Customer contacts\n" +
                "Condition: Name does not contain Depot",
                detail);
        }

        [Fact]
        public void ProfileSubgroupsAndSetOperations_UseBusinessGroupNumbers()
        {
            var definitionId = Guid.NewGuid();
            var service = new StubOrganizationService(
                new Entity("msdynmkt_segmentdefinition", definitionId)
                {
                    ["msdynmkt_segmentquery"] =
                        "PROFILE(contact)" +
                        ".FILTER(ISNOTNULL(emailaddress1))" +
                        ".FILTER(klth_risikoprofil IN [700370003, 700370004])" +
                        " INTERSECT PROFILE(contact)" +
                        ".FILTER(ISNOTNULL(firstname))",
                    ["modifiedon"] = DateTime.UtcNow
                });

            var request = BuildRequest(service, definitionId);
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operand = query.GetType().GetProperty("FirstOperand").GetValue(query);
            var steps = ((IEnumerable)operand
                .GetType()
                .GetProperty("Steps")
                .GetValue(operand))
                .Cast<object>()
                .ToList();
            var operations = ((IEnumerable)query
                .GetType()
                .GetProperty("SetOperations")
                .GetValue(query))
                .Cast<object>()
                .ToList();

            Assert.Equal(
                new[] { "1", "1.1" },
                steps.Select(step => (string)step
                    .GetType()
                    .GetProperty("GroupLabel")
                    .GetValue(step)));
            Assert.Equal(
                "2",
                operations[0]
                    .GetType()
                    .GetProperty("GroupLabel")
                    .GetValue(operations[0]));

            var assembly = typeof(
                CustomerInsightsSegmentSankey.CustomApi.GetSegmentFilterCountsPlugin)
                .Assembly;
            var clientType = assembly.GetType(
                "CustomerInsightsSegmentSankey.CustomApi.FabricSegmentCountApiClient",
                true);
            var metadata = ((IEnumerable)clientType
                .GetMethod(
                    "BuildStageMetadata",
                    BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, new[] { query }))
                .Cast<object>()
                .ToList();

            Assert.Equal(4, metadata.Count);
            Assert.Null(metadata[0].GetType().GetProperty("GroupLabel").GetValue(metadata[0]));
            Assert.Equal(
                new[] { "1", "1.1", "2" },
                metadata.Skip(1).Select(item => (string)item
                    .GetType()
                    .GetProperty("GroupLabel")
                    .GetValue(item)));
            Assert.NotNull(metadata[2]
                .GetType()
                .GetProperty("Presentation")
                .GetValue(metadata[2]));
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

        private static string BuildFirstProfileStepDetail(
            IOrganizationService service,
            Guid definitionId)
        {
            var request = BuildRequest(service, definitionId);
            var query = request.GetType().GetProperty("Query").GetValue(request);
            var operand = query.GetType().GetProperty("FirstOperand").GetValue(query);
            var steps = ((IEnumerable)operand
                .GetType()
                .GetProperty("Steps")
                .GetValue(operand))
                .Cast<object>()
                .ToList();

            Assert.Single(steps);
            return (string)steps[0]
                .GetType()
                .GetProperty("Detail")
                .GetValue(steps[0]);
        }

        private static object BuildRequest(
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
            return builderType.GetMethod("Build").Invoke(
                builder,
                new object[] { definitionId, false, false });
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
                var relationshipRequest = request as RetrieveRelationshipRequest;
                if (relationshipRequest != null &&
                    relationshipRequest.Name == "order_details")
                {
                    return new RetrieveRelationshipResponse
                    {
                        Results = new ParameterCollection
                        {
                            {
                                "RelationshipMetadata",
                                new OneToManyRelationshipMetadata
                                {
                                    SchemaName = relationshipRequest.Name,
                                    ReferencedEntity = "salesorder",
                                    ReferencedAttribute = "salesorderid",
                                    ReferencingEntity = "salesorderdetail",
                                    ReferencingAttribute = "salesorderid"
                                }
                            }
                        }
                    };
                }

                if (relationshipRequest != null &&
                    (relationshipRequest.Name == "order_customer_contacts" ||
                     relationshipRequest.Name == "contact_accounts"))
                {
                    return new RetrieveRelationshipResponse
                    {
                        Results = new ParameterCollection
                        {
                            {
                                "RelationshipMetadata",
                                new OneToManyRelationshipMetadata
                                {
                                    SchemaName = relationshipRequest.Name,
                                    ReferencedEntity = "contact",
                                    ReferencedAttribute = "contactid",
                                    ReferencingEntity = relationshipRequest.Name == "contact_accounts"
                                        ? "account"
                                        : "salesorder",
                                    ReferencingAttribute = "customerid"
                                }
                            }
                        }
                    };
                }

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
