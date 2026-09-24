using System;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal static class SegmentFilterCountPluginRequestReader
    {
        public static Guid ReadSegmentId(IPluginExecutionContext context)
        {
            if (!context.InputParameters.Contains("klth_segmentid") ||
                !(context.InputParameters["klth_segmentid"] is Guid))
            {
                throw new InvalidPluginExecutionException(
                    "The klth_segmentid parameter is missing or invalid.");
            }

            return (Guid)context.InputParameters["klth_segmentid"];
        }

        public static bool ReadProgressivePreview(IPluginExecutionContext context)
        {
            if (!context.InputParameters.Contains("klth_phase"))
            {
                return false;
            }

            var phase = context.InputParameters["klth_phase"] as string;
            if (string.IsNullOrWhiteSpace(phase) ||
                string.Equals(phase, "complete", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (string.Equals(phase, "preview", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            throw new InvalidPluginExecutionException(
                "The klth_phase parameter must be 'preview' or 'complete'.");
        }
    }

    internal static class SegmentFilterCountResultSerializer
    {
        public static string Serialize(FilterCountResult result)
        {
            var serializer = new DataContractJsonSerializer(typeof(FilterCountResult));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, result);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }
}
