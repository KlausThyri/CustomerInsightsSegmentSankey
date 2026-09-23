using System;
using System.Collections.Generic;
using System.Text;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
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
                    var relationship = ParseRelationshipPath();
                    Expect(MqlTokenKind.Dot, "'.FILTER' after relationship path");
                    steps.Add(new RelationshipFilterStep(
                        relationship,
                        ParseFilter(),
                        relationship.IsOptional));
                    continue;
                }

                throw Error("After '.', FILTER, RELATE or RELATEOPTIONAL is expected.");
            }

            return new ProfileOperand(entityName, steps);
        }

        private RelationshipPath ParseRelationshipPath()
        {
            var isOptional = IsWord("RELATEOPTIONAL");
            var operatorName = isOptional ? "RELATEOPTIONAL" : "RELATE";
            ExpectWord(operatorName);
            Expect(MqlTokenKind.LeftParenthesis, "'(' after " + operatorName);
            var relationship = ReadName("relationship schema");
            Expect(MqlTokenKind.Comma, "',' after relationship schema");
            var alias = ReadQualifiedName("relationship alias");
            RelationshipPath nested = null;
            if (tokenizer.Peek().Kind == MqlTokenKind.Comma)
            {
                tokenizer.Read();
                if (!IsWord("RELATE") && !IsWord("RELATEOPTIONAL"))
                {
                    throw Error(
                        "Expected nested RELATE(...) or RELATEOPTIONAL(...) relationship path.");
                }

                nested = ParseRelationshipPath();
            }

            Expect(MqlTokenKind.RightParenthesis, "')' after " + operatorName);
            return new RelationshipPath(
                relationship,
                alias,
                isOptional,
                nested);
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

            if (IsWord("ISNULL"))
            {
                tokenizer.Read();
                Expect(MqlTokenKind.LeftParenthesis, "'(' after ISNULL");
                var field = ParseFieldReference();
                Expect(MqlTokenKind.RightParenthesis, "')' after ISNULL");
                return new PredicateCondition(
                    field,
                    PredicateOperator.IsNull,
                    new List<MqlLiteral>());
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

            throw Error("Expected ==, !=, a comparison operator, IN or CONTAINS.");
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

        private string ReadQualifiedName(string description)
        {
            var parts = new List<string> { ReadName(description) };
            while (tokenizer.Peek().Kind == MqlTokenKind.Dot)
            {
                tokenizer.Read();
                parts.Add(ReadName(description + " after '.'"));
            }

            return string.Join(".", parts);
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
}
