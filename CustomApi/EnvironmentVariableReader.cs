using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal static class EnvironmentVariableReader
    {
        public static IDictionary<string, string> ReadMany(
            IOrganizationService service,
            IEnumerable<string> schemaNames,
            IEnumerable<string> requiredSchemaNames)
        {
            var names = schemaNames
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var required = new HashSet<string>(
                requiredSchemaNames ?? Enumerable.Empty<string>(),
                StringComparer.OrdinalIgnoreCase);
            var results = names.ToDictionary(
                name => name,
                name => (string)null,
                StringComparer.OrdinalIgnoreCase);
            if (names.Count == 0)
            {
                return results;
            }

            var definitionQuery = new QueryExpression(
                "environmentvariabledefinition")
            {
                ColumnSet = new ColumnSet(
                    "environmentvariabledefinitionid",
                    "schemaname",
                    "defaultvalue"),
                NoLock = true
            };
            definitionQuery.Criteria.AddCondition(
                "schemaname",
                ConditionOperator.In,
                names.Cast<object>().ToArray());
            var definitions = service.RetrieveMultiple(definitionQuery)
                .Entities
                .GroupBy(
                    definition => definition.GetAttributeValue<string>(
                        "schemaname"),
                    StringComparer.OrdinalIgnoreCase)
                .Where(group => !string.IsNullOrWhiteSpace(group.Key))
                .ToDictionary(
                    group => group.Key,
                    group => group.First(),
                    StringComparer.OrdinalIgnoreCase);

            var definitionIds = definitions.Values
                .Select(definition => definition.Id)
                .Distinct()
                .ToList();
            var currentValues = new Dictionary<Guid, string>();
            if (definitionIds.Count > 0)
            {
                var valueQuery = new QueryExpression(
                    "environmentvariablevalue")
                {
                    ColumnSet = new ColumnSet(
                        "environmentvariabledefinitionid",
                        "value"),
                    NoLock = true
                };
                valueQuery.Criteria.AddCondition(
                    "environmentvariabledefinitionid",
                    ConditionOperator.In,
                    definitionIds.Cast<object>().ToArray());
                valueQuery.AddOrder("createdon", OrderType.Descending);
                foreach (var current in service.RetrieveMultiple(valueQuery)
                    .Entities)
                {
                    var definition = current.GetAttributeValue<EntityReference>(
                        "environmentvariabledefinitionid");
                    if (definition != null &&
                        !currentValues.ContainsKey(definition.Id))
                    {
                        currentValues[definition.Id] =
                            current.GetAttributeValue<string>("value");
                    }
                }
            }

            foreach (var name in names)
            {
                Entity definition;
                if (!definitions.TryGetValue(name, out definition))
                {
                    continue;
                }

                string value;
                results[name] = currentValues.TryGetValue(
                    definition.Id,
                    out value)
                    ? value
                    : definition.GetAttributeValue<string>("defaultvalue");
            }

            foreach (var name in required)
            {
                string value;
                if (!results.TryGetValue(name, out value) ||
                    string.IsNullOrWhiteSpace(value))
                {
                    throw new InvalidPluginExecutionException(
                        "The required environment variable '" + name +
                        "' is not configured.");
                }
            }

            return results.ToDictionary(
                pair => pair.Key,
                pair => string.IsNullOrWhiteSpace(pair.Value)
                    ? null
                    : pair.Value.Trim(),
                StringComparer.OrdinalIgnoreCase);
        }

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
