using System;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentCountSettingsProvider
    {
        private const string ApiUrlVariable = "klth_FabricBehavioralApiUrl";
        private const string ApiKeyVariable = "klth_FabricBehavioralApiKey";
        private const string BusinessUnitScopingVariable =
            "klth_BusinessUnitScopingEnabled";

        private readonly IOrganizationService service;

        public FabricSegmentCountSettingsProvider(IOrganizationService service)
        {
            this.service = service;
        }

        public FabricSegmentCountSettings Read()
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

            return new FabricSegmentCountSettings(
                behavioralEndpoint,
                settings[ApiKeyVariable],
                ReadBusinessUnitScopingEnabled(
                    settings[BusinessUnitScopingVariable]));
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
    }

    internal sealed class FabricSegmentCountSettings
    {
        public FabricSegmentCountSettings(
            Uri behavioralEndpoint,
            string apiKey,
            bool businessUnitScopingEnabled)
        {
            BehavioralEndpoint = behavioralEndpoint;
            ApiKey = apiKey;
            BusinessUnitScopingEnabled = businessUnitScopingEnabled;
        }

        public Uri BehavioralEndpoint { get; private set; }

        public string ApiKey { get; private set; }

        public bool BusinessUnitScopingEnabled { get; private set; }
    }
}
