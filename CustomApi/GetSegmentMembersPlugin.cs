using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    public sealed class GetSegmentMembersPlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(
                typeof(IPluginExecutionContext));
            var tracing = (ITracingService)serviceProvider.GetService(
                typeof(ITracingService));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(
                typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            var requestJson = context.InputParameters.Contains("klth_requestjson")
                ? context.InputParameters["klth_requestjson"] as string
                : null;
            if (string.IsNullOrWhiteSpace(requestJson))
            {
                throw new InvalidPluginExecutionException(
                    "The klth_requestjson parameter is missing.");
            }

            var request = JsonSerialization.Deserialize<SegmentMemberPageRequest>(requestJson);
            var fabricResult = new FabricSegmentMemberClient(service, tracing)
                .GetPage(request);
            if (!string.Equals(
                fabricResult.ProfileEntity,
                "contact",
                StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidPluginExecutionException(
                    "The member view currently supports contacts only.");
            }

            var rows = RetrieveAccessibleContacts(service, fabricResult.ProfileIds);
            var response = new SegmentMemberPageResponse
            {
                Rows = fabricResult.ProfileIds
                    .Where(rows.ContainsKey)
                    .Select(id => rows[id])
                    .ToList(),
                NextToken = fabricResult.NextToken,
                HasMore = fabricResult.HasMore,
                GeneratedAt = fabricResult.GeneratedAt
            };
            context.OutputParameters["klth_resultjson"] =
                JsonSerialization.Serialize(response);
        }

        private static IDictionary<Guid, SegmentMemberRow> RetrieveAccessibleContacts(
            IOrganizationService service,
            IList<Guid> profileIds)
        {
            var rows = new Dictionary<Guid, SegmentMemberRow>();
            if (profileIds == null || profileIds.Count == 0)
            {
                return rows;
            }

            var query = new QueryExpression("contact")
            {
                ColumnSet = new ColumnSet(
                    "contactid",
                    "fullname",
                    "firstname",
                    "lastname",
                    "emailaddress1",
                    "telephone1",
                    "address1_city",
                    "parentcustomerid"),
                NoLock = true
            };
            query.Criteria.AddCondition(
                "contactid",
                ConditionOperator.In,
                profileIds.Cast<object>().ToArray());

            foreach (var contact in service.RetrieveMultiple(query).Entities)
            {
                var company = contact.GetAttributeValue<EntityReference>("parentcustomerid");
                rows[contact.Id] = new SegmentMemberRow
                {
                    Id = contact.Id,
                    FullName = contact.GetAttributeValue<string>("fullname"),
                    FirstName = contact.GetAttributeValue<string>("firstname"),
                    LastName = contact.GetAttributeValue<string>("lastname"),
                    EmailAddress = contact.GetAttributeValue<string>("emailaddress1"),
                    Telephone = contact.GetAttributeValue<string>("telephone1"),
                    City = contact.GetAttributeValue<string>("address1_city"),
                    CompanyName = company == null ? null : company.Name
                };
            }

            return rows;
        }
    }

    internal sealed class FabricSegmentMemberClient
    {
        private const string ApiUrlVariable = "klth_FabricBehavioralApiUrl";
        private const string ApiKeyVariable = "klth_FabricBehavioralApiKey";
        private static readonly HttpClient HttpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(100)
        };

        private readonly IOrganizationService service;
        private readonly ITracingService tracing;

        public FabricSegmentMemberClient(
            IOrganizationService service,
            ITracingService tracing)
        {
            this.service = service;
            this.tracing = tracing;
        }

        public FabricSegmentMemberPage GetPage(SegmentMemberPageRequest input)
        {
            if (input == null || string.IsNullOrWhiteSpace(input.EvaluationToken))
            {
                throw new InvalidPluginExecutionException(
                    "The evaluation token for the member view is missing.");
            }

            var apiUrl = ReadEnvironmentVariable(ApiUrlVariable);
            Uri baseEndpoint;
            if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out baseEndpoint) ||
                baseEndpoint.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidPluginExecutionException(
                    "The environment variable " + ApiUrlVariable +
                    " must contain an absolute HTTPS URL.");
            }

            using (var request = new HttpRequestMessage(
                HttpMethod.Post,
                new Uri(baseEndpoint, "segment-members")))
            {
                request.Headers.Add(
                    "x-api-key",
                    ReadEnvironmentVariable(ApiKeyVariable));
                request.Content = new StringContent(
                    JsonSerialization.Serialize(new FabricSegmentMemberRequest
                    {
                        QueryToken = input.EvaluationToken,
                        StageOrder = input.StageOrder,
                        ViewMode = input.ViewMode,
                        Search = input.Search,
                        FilterField = input.FilterField,
                        FilterOperator = input.FilterOperator,
                        FilterValue = input.FilterValue,
                        SortField = input.SortField,
                        SortDirection = input.SortDirection,
                        PageSize = input.PageSize,
                        ContinuationToken = input.ContinuationToken
                    }),
                    Encoding.UTF8,
                    "application/json");
                tracing.Trace(
                    "Calling Fabric segment member API for stage {0}, view {1}.",
                    input.StageOrder,
                    input.ViewMode);

                using (var response = HttpClient.SendAsync(request).GetAwaiter().GetResult())
                {
                    var responseBody = response.Content.ReadAsStringAsync()
                        .GetAwaiter()
                        .GetResult();
                    if (!response.IsSuccessStatusCode)
                    {
                        var error = JsonSerialization.TryDeserialize<FabricMemberApiError>(
                            responseBody);
                        var message = error != null &&
                            !string.IsNullOrWhiteSpace(error.Message)
                                ? error.Message
                                : "The Fabric member query responded with HTTP " +
                                  ((int)response.StatusCode).ToString() + ".";
                        if (error != null && !string.IsNullOrWhiteSpace(error.Detail))
                        {
                            message += " " + error.Detail;
                        }

                        throw new InvalidPluginExecutionException(message);
                    }

                    return JsonSerialization.Deserialize<FabricSegmentMemberPage>(
                        responseBody);
                }
            }
        }

        private string ReadEnvironmentVariable(string schemaName)
        {
            var query = new QueryExpression("environmentvariabledefinition")
            {
                ColumnSet = new ColumnSet("defaultvalue"),
                TopCount = 1,
                NoLock = true
            };
            query.Criteria.AddCondition(
                "schemaname",
                ConditionOperator.Equal,
                schemaName);
            var valueLink = query.AddLink(
                "environmentvariablevalue",
                "environmentvariabledefinitionid",
                "environmentvariabledefinitionid",
                JoinOperator.LeftOuter);
            valueLink.EntityAlias = "currentvalue";
            valueLink.Columns = new ColumnSet("value");
            valueLink.Orders.Add(new OrderExpression("createdon", OrderType.Descending));

            var definition = service.RetrieveMultiple(query).Entities.FirstOrDefault();
            var current = definition == null
                ? null
                : definition.GetAttributeValue<AliasedValue>("currentvalue.value");
            var value = current == null
                ? definition == null
                    ? null
                    : definition.GetAttributeValue<string>("defaultvalue")
                : current.Value as string;
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new InvalidPluginExecutionException(
                    "The required environment variable '" + schemaName +
                    "' is not configured.");
            }

            return value.Trim();
        }
    }

    internal static class JsonSerialization
    {
        public static string Serialize<T>(T value)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, value);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        public static T Deserialize<T>(string json)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            {
                return (T)serializer.ReadObject(stream);
            }
        }

        public static T TryDeserialize<T>(string json) where T : class
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
    }

    [DataContract]
    internal sealed class SegmentMemberPageRequest
    {
        [DataMember(Name = "evaluationToken", Order = 1)]
        public string EvaluationToken { get; set; }

        [DataMember(Name = "stageOrder", Order = 2)]
        public int StageOrder { get; set; }

        [DataMember(Name = "viewMode", Order = 3)]
        public string ViewMode { get; set; }

        [DataMember(Name = "search", Order = 4, EmitDefaultValue = false)]
        public string Search { get; set; }

        [DataMember(Name = "filterField", Order = 5, EmitDefaultValue = false)]
        public string FilterField { get; set; }

        [DataMember(Name = "filterOperator", Order = 6, EmitDefaultValue = false)]
        public string FilterOperator { get; set; }

        [DataMember(Name = "filterValue", Order = 7, EmitDefaultValue = false)]
        public string FilterValue { get; set; }

        [DataMember(Name = "sortField", Order = 8)]
        public string SortField { get; set; }

        [DataMember(Name = "sortDirection", Order = 9)]
        public string SortDirection { get; set; }

        [DataMember(Name = "pageSize", Order = 10)]
        public int PageSize { get; set; }

        [DataMember(Name = "continuationToken", Order = 11, EmitDefaultValue = false)]
        public string ContinuationToken { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentMemberRequest
    {
        [DataMember(Name = "queryToken", Order = 1)]
        public string QueryToken { get; set; }

        [DataMember(Name = "stageOrder", Order = 2)]
        public int StageOrder { get; set; }

        [DataMember(Name = "viewMode", Order = 3)]
        public string ViewMode { get; set; }

        [DataMember(Name = "search", Order = 4, EmitDefaultValue = false)]
        public string Search { get; set; }

        [DataMember(Name = "filterField", Order = 5, EmitDefaultValue = false)]
        public string FilterField { get; set; }

        [DataMember(Name = "filterOperator", Order = 6, EmitDefaultValue = false)]
        public string FilterOperator { get; set; }

        [DataMember(Name = "filterValue", Order = 7, EmitDefaultValue = false)]
        public string FilterValue { get; set; }

        [DataMember(Name = "sortField", Order = 8)]
        public string SortField { get; set; }

        [DataMember(Name = "sortDirection", Order = 9)]
        public string SortDirection { get; set; }

        [DataMember(Name = "pageSize", Order = 10)]
        public int PageSize { get; set; }

        [DataMember(Name = "continuationToken", Order = 11, EmitDefaultValue = false)]
        public string ContinuationToken { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentMemberPage
    {
        [DataMember(Name = "profileEntity", Order = 1)]
        public string ProfileEntity { get; set; }

        [DataMember(Name = "profileIds", Order = 2)]
        public List<Guid> ProfileIds { get; set; }

        [DataMember(Name = "nextToken", Order = 3)]
        public string NextToken { get; set; }

        [DataMember(Name = "hasMore", Order = 4)]
        public bool HasMore { get; set; }

        [DataMember(Name = "generatedAt", Order = 5)]
        public string GeneratedAt { get; set; }
    }

    [DataContract]
    internal sealed class SegmentMemberPageResponse
    {
        [DataMember(Name = "rows", Order = 1)]
        public List<SegmentMemberRow> Rows { get; set; }

        [DataMember(Name = "nextToken", Order = 2)]
        public string NextToken { get; set; }

        [DataMember(Name = "hasMore", Order = 3)]
        public bool HasMore { get; set; }

        [DataMember(Name = "generatedAt", Order = 4)]
        public string GeneratedAt { get; set; }
    }

    [DataContract]
    internal sealed class SegmentMemberRow
    {
        [DataMember(Name = "id", Order = 1)]
        public Guid Id { get; set; }

        [DataMember(Name = "fullname", Order = 2)]
        public string FullName { get; set; }

        [DataMember(Name = "firstname", Order = 3)]
        public string FirstName { get; set; }

        [DataMember(Name = "lastname", Order = 4)]
        public string LastName { get; set; }

        [DataMember(Name = "emailaddress1", Order = 5)]
        public string EmailAddress { get; set; }

        [DataMember(Name = "telephone1", Order = 6)]
        public string Telephone { get; set; }

        [DataMember(Name = "address1_city", Order = 7)]
        public string City { get; set; }

        [DataMember(Name = "companyname", Order = 8)]
        public string CompanyName { get; set; }
    }

    [DataContract]
    internal sealed class FabricMemberApiError
    {
        [DataMember(Name = "message", Order = 1)]
        public string Message { get; set; }

        [DataMember(Name = "detail", Order = 2)]
        public string Detail { get; set; }
    }
}
