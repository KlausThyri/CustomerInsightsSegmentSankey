using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal static class EnvironmentVariableReader
    {
        public static string Read(
            IOrganizationService service,
            string schemaName,
            bool required)
        {
            var definitionQuery = new QueryExpression("environmentvariabledefinition")
            {
                ColumnSet = new ColumnSet(
                    "environmentvariabledefinitionid",
                    "defaultvalue"),
                TopCount = 1,
                NoLock = true
            };
            definitionQuery.Criteria.AddCondition(
                "schemaname",
                ConditionOperator.Equal,
                schemaName);

            var definition = service.RetrieveMultiple(definitionQuery)
                .Entities
                .FirstOrDefault();
            string value = null;
            if (definition != null)
            {
                var valueQuery = new QueryExpression("environmentvariablevalue")
                {
                    ColumnSet = new ColumnSet("value"),
                    TopCount = 1,
                    NoLock = true
                };
                valueQuery.Criteria.AddCondition(
                    "environmentvariabledefinitionid",
                    ConditionOperator.Equal,
                    definition.Id);
                valueQuery.AddOrder("createdon", OrderType.Descending);

                var current = service.RetrieveMultiple(valueQuery)
                    .Entities
                    .FirstOrDefault();
                value = current == null
                    ? definition.GetAttributeValue<string>("defaultvalue")
                    : current.GetAttributeValue<string>("value");
            }

            if (required && string.IsNullOrWhiteSpace(value))
            {
                throw new InvalidPluginExecutionException(
                    "The required environment variable '" + schemaName +
                    "' is not configured.");
            }

            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }
    }
}
