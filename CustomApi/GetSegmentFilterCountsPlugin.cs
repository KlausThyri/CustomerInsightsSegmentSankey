using System;
using System.Diagnostics;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    public sealed class GetSegmentFilterCountsPlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var actionTimer = Stopwatch.StartNew();
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);
            var segmentId = SegmentFilterCountPluginRequestReader.ReadSegmentId(context);
            var progressivePreview =
                SegmentFilterCountPluginRequestReader.ReadProgressivePreview(context);

            tracing.Trace("Calculating demographic MQL filter counts for segment {0}.", segmentId);

            var result = new FabricSegmentCountClient(
                service,
                tracing,
                context.OrganizationId)
                .Evaluate(segmentId, progressivePreview);
            if (result.Diagnostics != null && result.Diagnostics.TimingsMs != null)
            {
                result.Diagnostics.TimingsMs.DataverseAction =
                    actionTimer.Elapsed.TotalMilliseconds;
            }

            context.OutputParameters["klth_resultjson"] =
                SegmentFilterCountResultSerializer.Serialize(result);
        }
    }
}
