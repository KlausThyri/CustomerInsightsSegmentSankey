using System;
using System.Collections;
using System.Reflection;
using CustomerInsightsSegmentSankey.CustomApi;
using Xunit;

namespace CustomerInsightsSegmentSankey.CustomApi.Tests
{
    public sealed class MqlParserTests
    {
        [Theory]
        [InlineData(
            "PROFILE(contact).RELATEOPTIONAL(contact_customer_accounts, account_1).FILTER(account_1.name CONTAINS 'Depot')",
            "account_1")]
        [InlineData(
            "PROFILE(contact).RELATEOPTIONAL(contact_customer_accounts, account.account_1).FILTER(account_1.name CONTAINS 'Depot')",
            "account.account_1")]
        public void Parse_RelateOptional_AcceptsSupportedRelationshipArguments(
            string mql,
            string expectedAlias)
        {
            var relationship = ParseRelationship(mql);

            Assert.Equal(expectedAlias, ReadProperty<string>(relationship, "Alias"));
            Assert.True(ReadProperty<bool>(relationship, "IsOptional"));
        }

        [Fact]
        public void Parse_RelateOptional_AcceptsNestedCustomerInsightsMeasurePaths()
        {
            const string mql =
                "PROFILE(contact) " +
                ".RELATEOPTIONAL(msdynci_customerprofile_contact, msdynci_loyalitypoints_1, " +
                "RELATEOPTIONAL(msdynci_customerprofile_loyalitypoints, msdynci_loyalitypoints_1__1)) " +
                ".FILTER(msdynci_loyalitypoints_1__1.msdynci_sumofpoints >= 100) " +
                "INTERSECT PROFILE(contact) " +
                ".RELATEOPTIONAL(msdynci_customerprofile_contact, msdynci_webvisitslast7days_1, " +
                "RELATEOPTIONAL(msdynci_customerprofile_webvisitslast7days, msdynci_webvisitslast7days_1__1)) " +
                ".FILTER(msdynci_webvisitslast7days_1__1.msdynci_calculation1 >= 5)";

            var query = Parse(mql);
            var firstOperand = ReadProperty<object>(query, "FirstOperand");
            var steps = ReadProperty<IEnumerable>(firstOperand, "FilterSteps");
            var enumerator = steps.GetEnumerator();
            Assert.True(enumerator.MoveNext());
            var relationshipStep = enumerator.Current;
            var outer = ReadProperty<object>(relationshipStep, "Relationship");
            var nested = ReadProperty<object>(outer, "Nested");

            Assert.Equal(
                "msdynci_customerprofile_contact",
                ReadProperty<string>(outer, "RelationshipSchema"));
            Assert.Equal(
                "msdynci_customerprofile_loyalitypoints",
                ReadProperty<string>(nested, "RelationshipSchema"));
            Assert.Equal(
                "msdynci_loyalitypoints_1__1",
                ReadProperty<string>(nested, "Alias"));
            Assert.True(ReadProperty<bool>(nested, "IsOptional"));
            Assert.Single(ReadProperty<IEnumerable>(query, "SetOperations"));
        }

        [Fact]
        public void Parse_RelateOptional_RejectsScalarThirdArgument()
        {
            var exception = Assert.Throws<TargetInvocationException>(
                () => Parse(
                    "PROFILE(contact).RELATEOPTIONAL(contact_customer_accounts, account_1, extra).FILTER(account_1.name CONTAINS 'Depot')"));

            Assert.Contains(
                "Expected nested RELATE(...) or RELATEOPTIONAL(...)",
                exception.InnerException.Message);
        }

        private static object ParseRelationship(string mql)
        {
            var query = Parse(mql);
            var firstOperand = ReadProperty<object>(query, "FirstOperand");
            var steps = ReadProperty<IEnumerable>(firstOperand, "FilterSteps");
            var enumerator = steps.GetEnumerator();
            Assert.True(enumerator.MoveNext());
            return enumerator.Current;
        }

        private static object Parse(string mql)
        {
            var assembly = typeof(GetSegmentFilterCountsPlugin).Assembly;
            var parserType = assembly.GetType(
                "CustomerInsightsSegmentSankey.CustomApi.MqlParser",
                true);
            var parser = Activator.CreateInstance(
                parserType,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null,
                new object[] { mql },
                null);
            return parserType.GetMethod(
                "Parse",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Invoke(parser, null);
        }

        private static T ReadProperty<T>(object instance, string name)
        {
            return (T)instance.GetType()
                .GetProperty(
                    name,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .GetValue(instance);
        }
    }
}
