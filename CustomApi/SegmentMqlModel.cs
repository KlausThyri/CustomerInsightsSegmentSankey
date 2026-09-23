using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class ConsentToken
    {
        public Guid ComplianceProfileId { get; private set; }

        public Guid PurposeId { get; private set; }

        public Guid? TopicId { get; private set; }

        public string Channel { get; private set; }

        public string EmailAttribute { get; private set; }

        public string Value { get; private set; }

        public static ConsentToken Parse(PredicateCondition predicate)
        {
            if (predicate.Operator != PredicateOperator.Equal &&
                predicate.Operator != PredicateOperator.IsNotNull)
            {
                throw new InvalidPluginExecutionException(
                    "Consent pseudo-fields support only == or ISNOTNULL.");
            }

            var candidates = new List<string> { predicate.Field.Name };
            foreach (var literal in predicate.Values)
            {
                var text = literal.Value as string;
                if (text != null)
                {
                    candidates.Add(text);
                }
            }

            string tokenText = null;
            foreach (var candidate in candidates)
            {
                var tokenStart = candidate.IndexOf("cp:", StringComparison.OrdinalIgnoreCase);
                if (tokenStart >= 0)
                {
                    tokenText = candidate.Substring(tokenStart);
                    break;
                }
            }

            if (tokenText == null)
            {
                throw new InvalidPluginExecutionException(
                    "The consent pseudo-field does not contain a token with cp:...;p:....");
            }

            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var component in tokenText.Split(';'))
            {
                var separator = component.IndexOf(':');
                if (separator <= 0 || separator == component.Length - 1)
                {
                    throw new InvalidPluginExecutionException(
                        "The consent token is invalid: '" + component + "'.");
                }

                var key = component.Substring(0, separator).Trim();
                var value = component.Substring(separator + 1).Trim();
                if (values.ContainsKey(key))
                {
                    throw new InvalidPluginExecutionException(
                        "The consent token contains '" + key + "' more than once.");
                }

                values.Add(key, value);
            }

            string complianceText;
            string purposeText;
            Guid complianceId;
            Guid purposeId;
            if (!values.TryGetValue("cp", out complianceText) ||
                !Guid.TryParse(complianceText, out complianceId) ||
                !values.TryGetValue("p", out purposeText) ||
                !Guid.TryParse(purposeText, out purposeId))
            {
                throw new InvalidPluginExecutionException(
                    "The consent token requires valid GUIDs for cp and p.");
            }

            Guid? topicId = null;
            string topicText;
            if (values.TryGetValue("t", out topicText))
            {
                Guid parsedTopic;
                if (!Guid.TryParse(topicText, out parsedTopic))
                {
                    throw new InvalidPluginExecutionException(
                        "The consent token does not contain a valid GUID for t.");
                }

                topicId = parsedTopic;
            }

            string channel;
            values.TryGetValue("ch", out channel);
            string emailAttribute;
            if (!values.TryGetValue("ea", out emailAttribute))
            {
                emailAttribute = "emailaddress1";
            }

            string consentValue;
            values.TryGetValue("v", out consentValue);

            var supportedKeys = new HashSet<string>(
                new[] { "cp", "p", "ch", "ea", "t", "v" },
                StringComparer.OrdinalIgnoreCase);
            foreach (var key in values.Keys)
            {
                if (!supportedKeys.Contains(key))
                {
                    throw new InvalidPluginExecutionException(
                        "The consent token key '" + key + "' is not supported.");
                }
            }

            return new ConsentToken
            {
                ComplianceProfileId = complianceId,
                PurposeId = purposeId,
                TopicId = topicId,
                Channel = channel,
                EmailAttribute = emailAttribute,
                Value = consentValue
            };
        }
    }

    internal sealed class SegmentQuery
    {
        public SegmentQuery(
            SegmentOperand firstOperand,
            IList<SetOperation> setOperations)
        {
            FirstOperand = firstOperand;
            SetOperations = setOperations;
        }

        public SegmentOperand FirstOperand { get; private set; }

        public IList<SetOperation> SetOperations { get; private set; }
    }

    internal enum SetOperator
    {
        Intersect,
        Union,
        Except
    }

    internal sealed class SetOperation
    {
        public SetOperation(SetOperator setOperator, SegmentOperand operand)
        {
            Operator = setOperator;
            Operand = operand;
        }

        public SetOperator Operator { get; private set; }

        public SegmentOperand Operand { get; private set; }
    }

    internal abstract class SegmentOperand
    {
        public abstract string Describe();
    }

    internal sealed class ProfileOperand : SegmentOperand
    {
        public ProfileOperand(string entityName, IList<MqlFilterStep> filterSteps)
        {
            EntityName = entityName;
            FilterSteps = filterSteps;
        }

        public string EntityName { get; private set; }

        public IList<MqlFilterStep> FilterSteps { get; private set; }

        public override string Describe()
        {
            return "PROFILE(" + EntityName + ")";
        }
    }

    internal sealed class SegmentReferenceOperand : SegmentOperand
    {
        public SegmentReferenceOperand(Guid segmentId)
        {
            SegmentId = segmentId;
        }

        public Guid SegmentId { get; private set; }

        public override string Describe()
        {
            return "SEGMENT(SEGMENT_CJO_ID_" + SegmentId.ToString("N") + ")";
        }
    }

    internal sealed class InteractionOperand : SegmentOperand
    {
        public InteractionOperand(
            string eventLogicalName,
            string entityIdField,
            ConditionNode filter,
            HavingClause having)
        {
            EventLogicalName = eventLogicalName;
            EntityIdField = entityIdField;
            Filter = filter;
            Having = having;
        }

        public string EventLogicalName { get; private set; }

        public string EntityIdField { get; private set; }

        public ConditionNode Filter { get; private set; }

        public HavingClause Having { get; private set; }

        public string ResolveProfileEntity()
        {
            var entities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            CollectProfileEntities(Filter, entities);
            if (entities.Count != 1 ||
                (!entities.Contains("contact") && !entities.Contains("lead")))
            {
                throw new InvalidPluginExecutionException(
                    "An Interaction operand must unambiguously specify the profile type via " +
                    EntityIdField + "_LogicalName == 'contact' or 'lead'.");
            }

            return entities.First();
        }

        public override string Describe()
        {
            var text = "Interaction(" + EventLogicalName + ", " + EntityIdField + ")";
            if (Filter != null)
            {
                text += ".FILTER(" + Filter.Describe() + ")";
            }

            if (Having != null)
            {
                text += "." + Having.Describe();
            }

            return text;
        }

        private static void CollectProfileEntities(
            ConditionNode condition,
            ISet<string> entities)
        {
            if (condition == null)
            {
                return;
            }

            var predicate = condition as PredicateCondition;
            if (predicate != null &&
                predicate.Operator == PredicateOperator.Equal &&
                predicate.Field.Name.EndsWith(
                    "_LogicalName",
                    StringComparison.OrdinalIgnoreCase) &&
                predicate.Values.Count == 1)
            {
                var value = predicate.Values[0].Value as string;
                if (!string.IsNullOrWhiteSpace(value))
                {
                    entities.Add(value);
                }

                return;
            }

            var not = condition as NotCondition;
            if (not != null)
            {
                CollectProfileEntities(not.Inner, entities);
                return;
            }

            var and = condition as AndCondition;
            if (and != null)
            {
                foreach (var child in and.Children)
                {
                    CollectProfileEntities(child, entities);
                }

                return;
            }

            var or = condition as OrCondition;
            if (or != null)
            {
                foreach (var child in or.Children)
                {
                    CollectProfileEntities(child, entities);
                }
            }
        }
    }

    internal sealed class HavingClause
    {
        public HavingClause(
            string metric,
            string comparisonOperator,
            long threshold,
            string windowFunction,
            int? windowValue)
        {
            Metric = metric;
            ComparisonOperator = comparisonOperator;
            Threshold = threshold;
            WindowFunction = windowFunction;
            WindowValue = windowValue;
        }

        public string Metric { get; private set; }

        public string ComparisonOperator { get; private set; }

        public long Threshold { get; private set; }

        public string WindowFunction { get; private set; }

        public int? WindowValue { get; private set; }

        public string Describe()
        {
            var text = "Having(" + Metric + "() " + ComparisonOperator + " " +
                Threshold.ToString();
            if (!string.IsNullOrEmpty(WindowFunction) && WindowValue.HasValue)
            {
                text += ", " + WindowFunction + "(" + WindowValue.Value.ToString() + ")";
            }

            return text + ")";
        }
    }

    internal abstract class MqlFilterStep
    {
    }

    internal sealed class ProfileFilterStep : MqlFilterStep
    {
        public ProfileFilterStep(ConditionNode condition)
        {
            Condition = condition;
        }

        public ConditionNode Condition { get; private set; }
    }

    internal sealed class RelationshipFilterStep : MqlFilterStep
    {
        public RelationshipFilterStep(
            RelationshipPath relationship,
            ConditionNode condition,
            bool isOptional)
        {
            Relationship = relationship;
            Condition = condition;
            IsOptional = isOptional;
        }

        public RelationshipPath Relationship { get; private set; }

        public string RelationshipSchema
        {
            get { return Relationship.RelationshipSchema; }
        }

        public string Alias
        {
            get { return Relationship.Alias; }
        }

        public ConditionNode Condition { get; private set; }

        public bool IsOptional { get; private set; }
    }

    internal sealed class RelationshipPath
    {
        public RelationshipPath(
            string relationshipSchema,
            string alias,
            bool isOptional,
            RelationshipPath nested)
        {
            RelationshipSchema = relationshipSchema;
            Alias = alias;
            IsOptional = isOptional;
            Nested = nested;
        }

        public string RelationshipSchema { get; private set; }

        public string Alias { get; private set; }

        public bool IsOptional { get; private set; }

        public RelationshipPath Nested { get; private set; }
    }

    internal abstract class ConditionNode
    {
        public abstract string Describe();
    }

    internal sealed class AndCondition : ConditionNode
    {
        public AndCondition(IEnumerable<ConditionNode> children)
        {
            Children = children.ToList();
        }

        public IList<ConditionNode> Children { get; private set; }

        public override string Describe()
        {
            return "(" + string.Join(
                " AND ",
                Children.Select(child => child.Describe()).ToArray()) + ")";
        }
    }

    internal sealed class OrCondition : ConditionNode
    {
        public OrCondition(IEnumerable<ConditionNode> children)
        {
            Children = children.ToList();
        }

        public IList<ConditionNode> Children { get; private set; }

        public override string Describe()
        {
            return "(" + string.Join(
                " OR ",
                Children.Select(child => child.Describe()).ToArray()) + ")";
        }
    }

    internal sealed class NotCondition : ConditionNode
    {
        public NotCondition(ConditionNode inner)
        {
            Inner = inner;
        }

        public ConditionNode Inner { get; private set; }

        public override string Describe()
        {
            return "NOT(" + Inner.Describe() + ")";
        }
    }

    internal enum PredicateOperator
    {
        IsNull,
        IsNotNull,
        Equal,
        NotEqual,
        GreaterThan,
        GreaterOrEqual,
        LessThan,
        LessOrEqual,
        In,
        Contains
    }

    internal sealed class PredicateCondition : ConditionNode
    {
        public PredicateCondition(
            FieldReference field,
            PredicateOperator predicateOperator,
            IList<MqlLiteral> values)
        {
            Field = field;
            Operator = predicateOperator;
            Values = values;
        }

        public FieldReference Field { get; private set; }

        public PredicateOperator Operator { get; private set; }

        public IList<MqlLiteral> Values { get; private set; }

        public override string Describe()
        {
            if (Operator == PredicateOperator.IsNull)
            {
                return "ISNULL(" + Field.Describe() + ")";
            }

            if (Operator == PredicateOperator.IsNotNull)
            {
                return "ISNOTNULL(" + Field.Describe() + ")";
            }

            var operatorText = Operator == PredicateOperator.Equal
                ? " == "
                : Operator == PredicateOperator.NotEqual
                    ? " != "
                    : Operator == PredicateOperator.GreaterThan
                        ? " > "
                        : Operator == PredicateOperator.GreaterOrEqual
                            ? " >= "
                            : Operator == PredicateOperator.LessThan
                                ? " < "
                                : Operator == PredicateOperator.LessOrEqual
                                    ? " <= "
                                    : Operator == PredicateOperator.In ? " IN " : " CONTAINS ";
            if (Operator == PredicateOperator.In)
            {
                return Field.Describe() + operatorText + "[" +
                    string.Join(", ", Values.Select(value => value.Describe()).ToArray()) + "]";
            }

            return Field.Describe() + operatorText + Values[0].Describe();
        }
    }

    internal sealed class FieldReference
    {
        public FieldReference(string qualifier, string name)
        {
            Qualifier = qualifier;
            Name = name;
        }

        public string Qualifier { get; private set; }

        public string Name { get; private set; }

        public string Describe()
        {
            return string.IsNullOrEmpty(Qualifier)
                ? Name
                : Qualifier + "." + Name;
        }
    }

    internal sealed class MqlLiteral
    {
        public MqlLiteral(object value)
        {
            Value = value;
        }

        public object Value { get; private set; }

        public string Describe()
        {
            var text = Value as string;
            return text == null
                ? Convert.ToString(Value)
                : "'" + text.Replace("'", "''") + "'";
        }
    }
}
