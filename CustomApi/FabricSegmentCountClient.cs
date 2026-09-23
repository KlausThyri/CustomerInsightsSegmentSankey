using System;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentCountClient
    {
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
            var settings = new FabricSegmentCountSettingsProvider(service)
                .Read();
            var requestPayload = new FabricSegmentRequestBuilder(service)
                .Build(
                    segmentDefinitionId,
                    settings.BusinessUnitScopingEnabled);
            var dependencies = new FabricTableDependencyResolver(service, tracing)
                .Resolve(requestPayload);
            requestPayload.RequiredDataverseTables =
                dependencies.RequiredTables.ToList();

            return new FabricSegmentCountApiClient(tracing)
                .Evaluate(segmentDefinitionId, settings, requestPayload, dependencies);
        }
    }
}
