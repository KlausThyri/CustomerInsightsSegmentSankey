using System;
using System.Collections.Generic;
using System.Runtime.Serialization;

namespace CustomerInsightsSegmentSankey.CustomApi
{
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
            string evaluationToken,
            FabricSegmentDiagnostics diagnostics)
        {
            GeneratedAt = generatedAt.ToString("o");
            IsEstimate = isEstimate;
            Stages = stages;
            FabricDependencies = fabricDependencies;
            EvaluationToken = evaluationToken;
            Diagnostics = diagnostics;
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

        [DataMember(Name = "diagnostics", Order = 6, EmitDefaultValue = false)]
        public FabricSegmentDiagnostics Diagnostics { get; private set; }
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
