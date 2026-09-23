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
