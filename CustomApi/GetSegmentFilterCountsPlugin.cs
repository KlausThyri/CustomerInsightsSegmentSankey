using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    public sealed class GetSegmentFilterCountsPlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            if (!context.InputParameters.Contains("klth_segmentid") ||
                !(context.InputParameters["klth_segmentid"] is Guid))
            {
                throw new InvalidPluginExecutionException(
                    "The klth_segmentid parameter is missing or invalid.");
            }

            var segmentId = (Guid)context.InputParameters["klth_segmentid"];
            tracing.Trace("Calculating demographic MQL filter counts for segment {0}.", segmentId);

            var dependencies = new FabricTableDependencyResolver(
                service,
                tracing).Resolve(segmentId);
            dependencies.SetAddedTables(
                new FabricDependencyProvisioningClient(service, tracing)
                    .EnsureDataverseTables(dependencies.RequiredTables));
            var result = new FabricSegmentCountClient(service, tracing)
                .Evaluate(segmentId, dependencies);
            context.OutputParameters["klth_resultjson"] = Serialize(result);
        }

        private static string Serialize(FilterCountResult result)
        {
            var serializer = new DataContractJsonSerializer(typeof(FilterCountResult));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, result);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }

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
            string relationshipSchema,
            string alias,
            ConditionNode condition,
            bool isOptional)
        {
            RelationshipSchema = relationshipSchema;
            Alias = alias;
            Condition = condition;
            IsOptional = isOptional;
        }

        public string RelationshipSchema { get; private set; }

        public string Alias { get; private set; }

        public ConditionNode Condition { get; private set; }

        public bool IsOptional { get; private set; }
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

    internal sealed class MqlParser
    {
        private readonly MqlTokenizer tokenizer;

        public MqlParser(string mql)
        {
            tokenizer = new MqlTokenizer(mql);
        }

        public SegmentQuery Parse()
        {
            var first = ParseOperand();
            var operations = new List<SetOperation>();
            while (IsWord("INTERSECT") || IsWord("UNION") || IsWord("EXCEPT"))
            {
                var setOperator = IsWord("INTERSECT")
                    ? SetOperator.Intersect
                    : IsWord("UNION")
                    ? SetOperator.Union
                    : SetOperator.Except;
                tokenizer.Read();
                operations.Add(new SetOperation(setOperator, ParseOperand()));
            }

            Expect(MqlTokenKind.End, "end of MQL query");
            return new SegmentQuery(first, operations);
        }

        private SegmentOperand ParseOperand()
        {
            if (IsWord("PROFILE"))
            {
                return ParseProfile();
            }

            if (IsWord("SEGMENT"))
            {
                return ParseSegmentReference();
            }

            if (IsWord("INTERACTION"))
            {
                return ParseInteraction();
            }

            throw Error("Expected PROFILE(...), SEGMENT(...) or Interaction(...).");
        }

        private ProfileOperand ParseProfile()
        {
            ExpectWord("PROFILE");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after PROFILE");
            var entityName = ReadName("PROFILE entity");
            Expect(MqlTokenKind.RightParenthesis, "')' after PROFILE entity");

            var steps = new List<MqlFilterStep>();
            while (tokenizer.Peek().Kind == MqlTokenKind.Dot)
            {
                tokenizer.Read();
                if (IsWord("FILTER"))
                {
                    steps.Add(new ProfileFilterStep(ParseFilter()));
                    continue;
                }

                if (IsWord("RELATE") || IsWord("RELATEOPTIONAL"))
                {
                    var isOptional = IsWord("RELATEOPTIONAL");
                    var operatorName = isOptional ? "RELATEOPTIONAL" : "RELATE";
                    tokenizer.Read();
                    Expect(MqlTokenKind.LeftParenthesis, "'(' after " + operatorName);
                    var relationship = ReadName("relationship schema");
                    Expect(MqlTokenKind.Comma, "',' after relationship schema");
                    var alias = ReadName("relationship alias");
                    Expect(MqlTokenKind.RightParenthesis, "')' after " + operatorName);
                    Expect(MqlTokenKind.Dot, "'.FILTER' after " + operatorName);
                    steps.Add(new RelationshipFilterStep(
                        relationship,
                        alias,
                        ParseFilter(),
                        isOptional));
                    continue;
                }

                throw Error("After '.', FILTER, RELATE or RELATEOPTIONAL is expected.");
            }

            return new ProfileOperand(entityName, steps);
        }

        private SegmentReferenceOperand ParseSegmentReference()
        {
            ExpectWord("SEGMENT");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after SEGMENT");
            var segmentToken = ReadName("segment reference");
            Expect(MqlTokenKind.RightParenthesis, "')' after segment reference");

            const string prefix = "SEGMENT_CJO_ID_";
            if (!segmentToken.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw Error("A segment reference must start with SEGMENT_CJO_ID_.");
            }

            var guidText = segmentToken.Substring(prefix.Length);
            Guid segmentId;
            if (guidText.Length != 32 ||
                !Guid.TryParseExact(guidText, "N", out segmentId))
            {
                throw Error(
                    "SEGMENT_CJO_ID_ must be followed by exactly 32 hexadecimal GUID characters.");
            }

            return new SegmentReferenceOperand(segmentId);
        }

        private InteractionOperand ParseInteraction()
        {
            ExpectWord("INTERACTION");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after Interaction");
            var eventLogicalName = ReadName("Interaction event");
            Expect(MqlTokenKind.Comma, "',' after Interaction event");
            var entityIdField = ReadName("Interaction profile field");
            Expect(MqlTokenKind.RightParenthesis, "')' after Interaction profile field");

            ConditionNode filter = null;
            HavingClause having = null;
            while (tokenizer.Peek().Kind == MqlTokenKind.Dot)
            {
                tokenizer.Read();
                if (IsWord("FILTER"))
                {
                    if (filter != null)
                    {
                        throw Error("Interaction may contain only one FILTER.");
                    }

                    filter = ParseFilter();
                    continue;
                }

                if (IsWord("HAVING"))
                {
                    if (having != null)
                    {
                        throw Error("Interaction may contain only one HAVING.");
                    }

                    having = ParseHaving();
                    continue;
                }

                throw Error("After Interaction, FILTER or HAVING is expected.");
            }

            if (filter == null)
            {
                throw Error(
                    "Interaction requires a FILTER with the profile type (*_LogicalName).");
            }

            return new InteractionOperand(
                eventLogicalName,
                entityIdField,
                filter,
                having ?? new HavingClause("Count", ">=", 1, null, null));
        }

        private HavingClause ParseHaving()
        {
            ExpectWord("HAVING");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after HAVING");
            var metric = ReadIdentifier("HAVING metric");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after HAVING metric");
            Expect(MqlTokenKind.RightParenthesis, "')' after HAVING metric");
            var comparisonOperator = ReadComparisonOperator();
            var thresholdLiteral = ParseLiteral();
            long threshold;
            if (!long.TryParse(
                Convert.ToString(thresholdLiteral.Value),
                out threshold))
            {
                throw Error("The HAVING threshold must be an integer.");
            }

            string windowFunction = null;
            int? windowValue = null;
            if (tokenizer.Peek().Kind == MqlTokenKind.Comma)
            {
                tokenizer.Read();
                windowFunction = ReadIdentifier("time window function");
                Expect(MqlTokenKind.LeftParenthesis, "'(' after time window function");
                var windowLiteral = ParseLiteral();
                int parsedWindow;
                if (!int.TryParse(
                    Convert.ToString(windowLiteral.Value),
                    out parsedWindow) ||
                    parsedWindow <= 0)
                {
                    throw Error("The time window must be a positive integer.");
                }

                windowValue = parsedWindow;
                Expect(MqlTokenKind.RightParenthesis, "')' after time window");
            }

            Expect(MqlTokenKind.RightParenthesis, "')' after HAVING");
            return new HavingClause(
                metric,
                comparisonOperator,
                threshold,
                windowFunction,
                windowValue);
        }

        private ConditionNode ParseFilter()
        {
            ExpectWord("FILTER");
            Expect(MqlTokenKind.LeftParenthesis, "'(' after FILTER");
            var condition = ParseOrExpression();
            Expect(MqlTokenKind.RightParenthesis, "')' after FILTER");
            return condition;
        }

        private ConditionNode ParseOrExpression()
        {
            var children = new List<ConditionNode> { ParseAndExpression() };
            while (IsWord("OR"))
            {
                tokenizer.Read();
                children.Add(ParseAndExpression());
            }

            return children.Count == 1
                ? children[0]
                : new OrCondition(children);
        }

        private ConditionNode ParseAndExpression()
        {
            var children = new List<ConditionNode> { ParseUnaryExpression() };
            while (IsWord("AND"))
            {
                tokenizer.Read();
                children.Add(ParseUnaryExpression());
            }

            return children.Count == 1
                ? children[0]
                : new AndCondition(children);
        }

        private ConditionNode ParseUnaryExpression()
        {
            if (IsWord("NOT"))
            {
                tokenizer.Read();
                Expect(MqlTokenKind.LeftParenthesis, "'(' after NOT");
                var inner = ParseOrExpression();
                Expect(MqlTokenKind.RightParenthesis, "')' after NOT");
                return new NotCondition(inner);
            }

            if (tokenizer.Peek().Kind == MqlTokenKind.LeftParenthesis)
            {
                tokenizer.Read();
                var grouped = ParseOrExpression();
                Expect(MqlTokenKind.RightParenthesis, "')' after AND group");
                return grouped;
            }

            if (IsWord("ISNOTNULL"))
            {
                tokenizer.Read();
                Expect(MqlTokenKind.LeftParenthesis, "'(' after ISNOTNULL");
                var field = ParseFieldReference();
                Expect(MqlTokenKind.RightParenthesis, "')' after ISNOTNULL");
                return new PredicateCondition(
                    field,
                    PredicateOperator.IsNotNull,
                    new List<MqlLiteral>());
            }

            var predicateField = ParseFieldReference();
            if (tokenizer.Peek().Kind == MqlTokenKind.EqualEqual)
            {
                tokenizer.Read();
                return new PredicateCondition(
                    predicateField,
                    PredicateOperator.Equal,
                    new[] { ParseLiteral() });
            }

            if (tokenizer.Peek().Kind == MqlTokenKind.NotEqual)
            {
                tokenizer.Read();
                return new PredicateCondition(
                    predicateField,
                    PredicateOperator.NotEqual,
                    new[] { ParseLiteral() });
            }

            if (tokenizer.Peek().Kind == MqlTokenKind.GreaterThan ||
                tokenizer.Peek().Kind == MqlTokenKind.GreaterOrEqual ||
                tokenizer.Peek().Kind == MqlTokenKind.LessThan ||
                tokenizer.Peek().Kind == MqlTokenKind.LessOrEqual)
            {
                var comparison = tokenizer.Read();
                var predicateOperator = comparison.Kind == MqlTokenKind.GreaterThan
                    ? PredicateOperator.GreaterThan
                    : comparison.Kind == MqlTokenKind.GreaterOrEqual
                        ? PredicateOperator.GreaterOrEqual
                        : comparison.Kind == MqlTokenKind.LessThan
                            ? PredicateOperator.LessThan
                            : PredicateOperator.LessOrEqual;
                return new PredicateCondition(
                    predicateField,
                    predicateOperator,
                    new[] { ParseLiteral() });
            }

            if (IsWord("IN"))
            {
                tokenizer.Read();
                Expect(MqlTokenKind.LeftBracket, "'[' after IN");
                var values = new List<MqlLiteral> { ParseLiteral() };
                while (tokenizer.Peek().Kind == MqlTokenKind.Comma)
                {
                    tokenizer.Read();
                    values.Add(ParseLiteral());
                }

                Expect(MqlTokenKind.RightBracket, "']' after IN literals");
                return new PredicateCondition(
                    predicateField,
                    PredicateOperator.In,
                    values);
            }

            if (IsWord("CONTAINS"))
            {
                tokenizer.Read();
                return new PredicateCondition(
                    predicateField,
                    PredicateOperator.Contains,
                    new[] { ParseLiteral() });
            }

            throw Error("Expected ==, IN or CONTAINS.");
        }

        private string ReadComparisonOperator()
        {
            var token = tokenizer.Read();
            switch (token.Kind)
            {
                case MqlTokenKind.EqualEqual:
                    return "==";
                case MqlTokenKind.NotEqual:
                    return "!=";
                case MqlTokenKind.GreaterThan:
                    return ">";
                case MqlTokenKind.GreaterOrEqual:
                    return ">=";
                case MqlTokenKind.LessThan:
                    return "<";
                case MqlTokenKind.LessOrEqual:
                    return "<=";
                default:
                    throw Error("Expected a HAVING comparison operator.");
            }
        }

        private FieldReference ParseFieldReference()
        {
            var first = ReadIdentifier("field name");
            if (tokenizer.Peek().Kind != MqlTokenKind.Dot)
            {
                return new FieldReference(null, first);
            }

            tokenizer.Read();
            return new FieldReference(first, ReadIdentifier("field name after alias"));
        }

        private MqlLiteral ParseLiteral()
        {
            var token = tokenizer.Read();
            if (token.Kind == MqlTokenKind.String)
            {
                return new MqlLiteral(token.Text);
            }

            if (token.Kind == MqlTokenKind.Number)
            {
                int number;
                if (!int.TryParse(token.Text, out number))
                {
                    throw Error("Integer out of the supported range.");
                }

                return new MqlLiteral(number);
            }

            if (token.Kind == MqlTokenKind.Identifier)
            {
                int number;
                return int.TryParse(token.Text, out number)
                    ? new MqlLiteral(number)
                    : new MqlLiteral(token.Text);
            }

            throw Error("Expected a string, GUID string, or integer literal.");
        }

        private string ReadName(string description)
        {
            var token = tokenizer.Read();
            if (token.Kind != MqlTokenKind.Identifier &&
                token.Kind != MqlTokenKind.String)
            {
                throw Error("Expected " + description + ".");
            }

            return token.Text;
        }

        private string ReadIdentifier(string description)
        {
            var token = tokenizer.Read();
            if (token.Kind != MqlTokenKind.Identifier)
            {
                throw Error("Expected " + description + ".");
            }

            return token.Text;
        }

        private bool IsWord(string value)
        {
            var token = tokenizer.Peek();
            if (token.Kind != MqlTokenKind.Identifier)
            {
                return false;
            }

            if (string.Equals(value, "AND", StringComparison.OrdinalIgnoreCase) && token.Text == "&&")
            {
                return true;
            }

            if (string.Equals(value, "OR", StringComparison.OrdinalIgnoreCase) && token.Text == "||")
            {
                return true;
            }

            return string.Equals(token.Text, value, StringComparison.OrdinalIgnoreCase);
        }

        private void ExpectWord(string value)
        {
            if (!IsWord(value))
            {
                throw Error("Expected '" + value + "'.");
            }

            tokenizer.Read();
        }

        private void Expect(MqlTokenKind kind, string description)
        {
            var token = tokenizer.Read();
            if (token.Kind != kind)
            {
                throw Error("Expected " + description + ".");
            }
        }

        private InvalidPluginExecutionException Error(string message)
        {
            return new InvalidPluginExecutionException(
                "Unsupported or invalid demographic MQL syntax at position " +
                tokenizer.Position.ToString() + ": " + message);
        }
    }

    internal enum MqlTokenKind
    {
        Identifier,
        String,
        Number,
        EqualEqual,
        NotEqual,
        GreaterThan,
        GreaterOrEqual,
        LessThan,
        LessOrEqual,
        LeftParenthesis,
        RightParenthesis,
        LeftBracket,
        RightBracket,
        Comma,
        Dot,
        End
    }

    internal sealed class MqlToken
    {
        public MqlToken(MqlTokenKind kind, string text)
        {
            Kind = kind;
            Text = text;
        }

        public MqlTokenKind Kind { get; private set; }

        public string Text { get; private set; }
    }

    internal sealed class MqlTokenizer
    {
        private readonly string text;
        private int position;
        private MqlToken buffered;

        public MqlTokenizer(string text)
        {
            this.text = text;
        }

        public int Position
        {
            get { return position; }
        }

        public MqlToken Peek()
        {
            if (buffered == null)
            {
                buffered = ReadCore();
            }

            return buffered;
        }

        public MqlToken Read()
        {
            if (buffered != null)
            {
                var token = buffered;
                buffered = null;
                return token;
            }

            return ReadCore();
        }

        private MqlToken ReadCore()
        {
            SkipWhitespace();
            if (position >= text.Length)
            {
                return new MqlToken(MqlTokenKind.End, string.Empty);
            }

            var current = text[position];
            switch (current)
            {
                case '(':
                    position++;
                    return new MqlToken(MqlTokenKind.LeftParenthesis, "(");
                case ')':
                    position++;
                    return new MqlToken(MqlTokenKind.RightParenthesis, ")");
                case '[':
                    position++;
                    return new MqlToken(MqlTokenKind.LeftBracket, "[");
                case ']':
                    position++;
                    return new MqlToken(MqlTokenKind.RightBracket, "]");
                case ',':
                    position++;
                    return new MqlToken(MqlTokenKind.Comma, ",");
                case '.':
                    position++;
                    return new MqlToken(MqlTokenKind.Dot, ".");
                case '=':
                    if (position + 1 < text.Length && text[position + 1] == '=')
                    {
                        position += 2;
                        return new MqlToken(MqlTokenKind.EqualEqual, "==");
                    }

                    throw TokenError("A single '=' is not supported; '==' is expected.");
                case '!':
                    if (position + 1 < text.Length && text[position + 1] == '=')
                    {
                        position += 2;
                        return new MqlToken(MqlTokenKind.NotEqual, "!=");
                    }

                    throw TokenError("'=' is expected after '!'.");
                case '>':
                    if (position + 1 < text.Length && text[position + 1] == '=')
                    {
                        position += 2;
                        return new MqlToken(MqlTokenKind.GreaterOrEqual, ">=");
                    }

                    position++;
                    return new MqlToken(MqlTokenKind.GreaterThan, ">");
                case '<':
                    if (position + 1 < text.Length && text[position + 1] == '=')
                    {
                        position += 2;
                        return new MqlToken(MqlTokenKind.LessOrEqual, "<=");
                    }

                    position++;
                    return new MqlToken(MqlTokenKind.LessThan, "<");
                case '\'':
                case '"':
                    return ReadString(current);
            }

            if (char.IsDigit(current) ||
                (current == '-' &&
                 position + 1 < text.Length &&
                 char.IsDigit(text[position + 1])))
            {
                return ReadNumber();
            }

            return ReadIdentifier();
        }

        private MqlToken ReadString(char quote)
        {
            position++;
            var value = new StringBuilder();
            while (position < text.Length)
            {
                var current = text[position++];
                if (current == quote)
                {
                    if (position < text.Length && text[position] == quote)
                    {
                        position++;
                        value.Append(quote);
                        continue;
                    }

                    return new MqlToken(MqlTokenKind.String, value.ToString());
                }

                if (current == '\\' && position < text.Length)
                {
                    value.Append(text[position++]);
                }
                else
                {
                    value.Append(current);
                }
            }

            throw TokenError("Unterminated string literal.");
        }

        private MqlToken ReadNumber()
        {
            var start = position;
            if (text[position] == '-')
            {
                position++;
            }

            while (position < text.Length && char.IsDigit(text[position]))
            {
                position++;
            }

            return new MqlToken(
                MqlTokenKind.Number,
                text.Substring(start, position - start));
        }

        private MqlToken ReadIdentifier()
        {
            var start = position;
            while (position < text.Length &&
                   !char.IsWhiteSpace(text[position]) &&
                   "()[],.=!<>".IndexOf(text[position]) < 0)
            {
                position++;
            }

            if (start == position)
            {
                throw TokenError(
                    "Unexpected character '" + text[position].ToString() + "'.");
            }

            return new MqlToken(
                MqlTokenKind.Identifier,
                text.Substring(start, position - start));
        }

        private void SkipWhitespace()
        {
            while (position < text.Length && char.IsWhiteSpace(text[position]))
            {
                position++;
            }
        }

        private InvalidPluginExecutionException TokenError(string message)
        {
            return new InvalidPluginExecutionException(
                "Invalid demographic MQL syntax at position " +
                position.ToString() + ": " + message);
        }
    }

    [DataContract]
    internal sealed class FabricDependencyStatus
    {
        public FabricDependencyStatus(
            string linkProfile,
            IList<string> requiredTables,
            IList<string> addedTables,
            IList<string> behavioralEvents)
        {
            LinkProfile = linkProfile;
            RequiredTables = requiredTables;
            AddedTables = addedTables;
            BehavioralEvents = behavioralEvents;
        }

        [DataMember(Name = "linkProfile", Order = 1)]
        public string LinkProfile { get; private set; }

        [DataMember(Name = "requiredTables", Order = 2)]
        public IList<string> RequiredTables { get; private set; }

        [DataMember(Name = "addedTables", Order = 3)]
        public IList<string> AddedTables { get; private set; }

        [DataMember(Name = "behavioralEvents", Order = 4)]
        public IList<string> BehavioralEvents { get; private set; }

        public void SetAddedTables(IList<string> addedTables)
        {
            AddedTables = addedTables ?? new List<string>();
        }
    }

    [DataContract]
    internal sealed class FilterCountResult
    {
        public FilterCountResult(
            DateTime generatedAt,
            bool isEstimate,
            IList<FilterCountStage> stages,
            FabricDependencyStatus fabricDependencies,
            string evaluationToken)
        {
            GeneratedAt = generatedAt.ToString("o");
            IsEstimate = isEstimate;
            Stages = stages;
            FabricDependencies = fabricDependencies;
            EvaluationToken = evaluationToken;
        }

        [DataMember(Name = "generatedAt", Order = 1)]
        public string GeneratedAt { get; private set; }

        [DataMember(Name = "isEstimate", Order = 2)]
        public bool IsEstimate { get; private set; }

        [DataMember(Name = "stages", Order = 3)]
        public IList<FilterCountStage> Stages { get; private set; }

        [DataMember(Name = "fabricDependencies", Order = 4)]
        public FabricDependencyStatus FabricDependencies { get; private set; }

        [DataMember(Name = "evaluationToken", Order = 5)]
        public string EvaluationToken { get; private set; }
    }

    [DataContract]
    internal sealed class FilterCountStage
    {
        public FilterCountStage(int order, string label, string detail, long count)
        {
            Order = order;
            Label = label;
            Detail = detail;
            Count = count;
        }

        [DataMember(Name = "order", Order = 1)]
        public int Order { get; private set; }

        [DataMember(Name = "label", Order = 2)]
        public string Label { get; private set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; private set; }

        [DataMember(Name = "count", Order = 4)]
        public long Count { get; private set; }
    }
}
