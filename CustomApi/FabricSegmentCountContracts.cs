using System;
using System.Collections.Generic;
using System.Runtime.Serialization;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    [DataContract]
    internal sealed class FabricSegmentCountApiRequest
    {
        [DataMember(Name = "query", Order = 1)]
        public FabricSegmentQueryRequest Query { get; set; }

        [DataMember(Name = "requiredDataverseTables", Order = 2)]
        public List<string> RequiredDataverseTables { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentQueryRequest
    {
        public FabricSegmentQueryRequest()
        {
            SetOperations = new List<FabricSegmentSetOperationRequest>();
        }

        [DataMember(Name = "firstOperand", Order = 1)]
        public FabricSegmentOperandRequest FirstOperand { get; set; }

        [DataMember(Name = "setOperations", Order = 2)]
        public List<FabricSegmentSetOperationRequest> SetOperations { get; set; }

        [DataMember(Name = "businessUnitId", Order = 3, EmitDefaultValue = false)]
        public Guid? BusinessUnitId { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentSetOperationRequest
    {
        [DataMember(Name = "operator", Order = 1)]
        public string Operator { get; set; }

        [DataMember(Name = "operand", Order = 2)]
        public FabricSegmentOperandRequest Operand { get; set; }

        [DataMember(Name = "label", Order = 3)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 4)]
        public string Detail { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentOperandRequest
    {
        public FabricSegmentOperandRequest()
        {
            Steps = new List<FabricSegmentFilterStepRequest>();
            ProfileIds = new List<Guid>();
        }

        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "profileEntity", Order = 2)]
        public string ProfileEntity { get; set; }

        [DataMember(Name = "baseLabel", Order = 3)]
        public string BaseLabel { get; set; }

        [DataMember(Name = "baseDetail", Order = 4)]
        public string BaseDetail { get; set; }

        [DataMember(Name = "steps", Order = 5)]
        public List<FabricSegmentFilterStepRequest> Steps { get; set; }

        [DataMember(Name = "eventLogicalName", Order = 6, EmitDefaultValue = false)]
        public string EventLogicalName { get; set; }

        [DataMember(Name = "entityIdField", Order = 7, EmitDefaultValue = false)]
        public string EntityIdField { get; set; }

        [DataMember(Name = "filter", Order = 8, EmitDefaultValue = false)]
        public FabricSegmentConditionRequest Filter { get; set; }

        [DataMember(Name = "having", Order = 9, EmitDefaultValue = false)]
        public FabricSegmentHavingRequest Having { get; set; }

        [DataMember(Name = "profileIds", Order = 10)]
        public List<Guid> ProfileIds { get; set; }

        [DataMember(Name = "query", Order = 11, EmitDefaultValue = false)]
        public FabricSegmentQueryRequest Query { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentFilterStepRequest
    {
        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "label", Order = 2)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }

        [DataMember(Name = "condition", Order = 4)]
        public FabricSegmentConditionRequest Condition { get; set; }

        [DataMember(Name = "relatedEntity", Order = 5, EmitDefaultValue = false)]
        public string RelatedEntity { get; set; }

        [DataMember(Name = "profileAttribute", Order = 6, EmitDefaultValue = false)]
        public string ProfileAttribute { get; set; }

        [DataMember(Name = "relatedAttribute", Order = 7, EmitDefaultValue = false)]
        public string RelatedAttribute { get; set; }

        [DataMember(Name = "isOptional", Order = 8)]
        public bool IsOptional { get; set; }

        [DataMember(Name = "relationships", Order = 9, EmitDefaultValue = false)]
        public List<FabricRelationshipHopRequest> Relationships { get; set; }
    }

    [DataContract]
    internal sealed class FabricRelationshipHopRequest
    {
        [DataMember(Name = "alias", Order = 1)]
        public string Alias { get; set; }

        [DataMember(Name = "relatedEntity", Order = 2)]
        public string RelatedEntity { get; set; }

        [DataMember(Name = "sourceAttribute", Order = 3, EmitDefaultValue = false)]
        public string SourceAttribute { get; set; }

        [DataMember(Name = "relatedAttribute", Order = 4, EmitDefaultValue = false)]
        public string RelatedAttribute { get; set; }

        [DataMember(Name = "isOptional", Order = 5)]
        public bool IsOptional { get; set; }

        [DataMember(Name = "intersectEntity", Order = 6, EmitDefaultValue = false)]
        public string IntersectEntity { get; set; }

        [DataMember(Name = "sourceIntersectAttribute", Order = 7, EmitDefaultValue = false)]
        public string SourceIntersectAttribute { get; set; }

        [DataMember(Name = "relatedIntersectAttribute", Order = 8, EmitDefaultValue = false)]
        public string RelatedIntersectAttribute { get; set; }

        [DataMember(Name = "sourcePrimaryAttribute", Order = 9, EmitDefaultValue = false)]
        public string SourcePrimaryAttribute { get; set; }

        [DataMember(Name = "relatedPrimaryAttribute", Order = 10, EmitDefaultValue = false)]
        public string RelatedPrimaryAttribute { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentConditionRequest
    {
        [DataMember(Name = "kind", Order = 1)]
        public string Kind { get; set; }

        [DataMember(Name = "field", Order = 2, EmitDefaultValue = false)]
        public string Field { get; set; }

        [DataMember(Name = "qualifier", Order = 3, EmitDefaultValue = false)]
        public string Qualifier { get; set; }

        [DataMember(Name = "operator", Order = 4, EmitDefaultValue = false)]
        public string Operator { get; set; }

        [DataMember(Name = "value", Order = 5, EmitDefaultValue = false)]
        public object Value { get; set; }

        [DataMember(Name = "values", Order = 6, EmitDefaultValue = false)]
        public List<object> Values { get; set; }

        [DataMember(Name = "children", Order = 7, EmitDefaultValue = false)]
        public List<FabricSegmentConditionRequest> Children { get; set; }

        [DataMember(Name = "profileEmailField", Order = 8, EmitDefaultValue = false)]
        public string ProfileEmailField { get; set; }

        [DataMember(Name = "purposeId", Order = 9, EmitDefaultValue = false)]
        public Guid? PurposeId { get; set; }

        [DataMember(Name = "topicId", Order = 10, EmitDefaultValue = false)]
        public Guid? TopicId { get; set; }

        [DataMember(Name = "channel", Order = 11, EmitDefaultValue = false)]
        public string Channel { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentHavingRequest
    {
        [DataMember(Name = "metric", Order = 1)]
        public string Metric { get; set; }

        [DataMember(Name = "operator", Order = 2)]
        public string Operator { get; set; }

        [DataMember(Name = "threshold", Order = 3)]
        public long Threshold { get; set; }

        [DataMember(Name = "windowFunction", Order = 4, EmitDefaultValue = false)]
        public string WindowFunction { get; set; }

        [DataMember(Name = "windowValue", Order = 5, EmitDefaultValue = false)]
        public int? WindowValue { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentCountApiResponse
    {
        [DataMember(Name = "stages", Order = 1)]
        public List<FabricSegmentCountApiStage> Stages { get; set; }

        [DataMember(Name = "generatedAt", Order = 3)]
        public string GeneratedAt { get; set; }

        [DataMember(Name = "queryToken", Order = 4)]
        public string QueryToken { get; set; }

        [DataMember(Name = "addedTables", Order = 5)]
        public List<string> AddedTables { get; set; }

        [DataMember(Name = "catalogReady", Order = 6)]
        public bool CatalogReady { get; set; }

        [DataMember(Name = "diagnostics", Order = 7, EmitDefaultValue = false)]
        public FabricSegmentDiagnostics Diagnostics { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentCountApiStage
    {
        [DataMember(Name = "order", Order = 1)]
        public int Order { get; set; }

        [DataMember(Name = "label", Order = 2)]
        public string Label { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }

        [DataMember(Name = "count", Order = 4)]
        public long Count { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentApiError
    {
        [DataMember(Name = "code", Order = 1)]
        public string Code { get; set; }

        [DataMember(Name = "message", Order = 2)]
        public string Message { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }

        [DataMember(Name = "diagnostics", Order = 4, EmitDefaultValue = false)]
        public FabricSegmentDiagnostics Diagnostics { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentDiagnostics
    {
        [DataMember(Name = "schemaVersion", Order = 1)]
        public string SchemaVersion { get; set; }

        [DataMember(Name = "capturedAtUtc", Order = 2)]
        public string CapturedAtUtc { get; set; }

        [DataMember(Name = "apiVersion", Order = 3)]
        public string ApiVersion { get; set; }

        [DataMember(Name = "requestId", Order = 4)]
        public string RequestId { get; set; }

        [DataMember(Name = "errorCode", Order = 5, EmitDefaultValue = false)]
        public string ErrorCode { get; set; }

        [DataMember(Name = "timingsMs", Order = 6)]
        public FabricSegmentDiagnosticTimings TimingsMs { get; set; }

        [DataMember(Name = "queryComplexity", Order = 7)]
        public FabricSegmentQueryComplexity QueryComplexity { get; set; }

        [DataMember(Name = "runtime", Order = 8)]
        public FabricSegmentDiagnosticRuntime Runtime { get; set; }

        [DataMember(Name = "sourceTables", Order = 9)]
        public List<string> SourceTables { get; set; }

        [DataMember(Name = "identifiers", Order = 10)]
        public FabricSegmentDiagnosticIdentifiers Identifiers { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentDiagnosticTimings
    {
        [DataMember(Name = "apiTotal", Order = 1)]
        public double ApiTotal { get; set; }

        [DataMember(Name = "capacityReadiness", Order = 2)]
        public double CapacityReadiness { get; set; }

        [DataMember(Name = "catalog", Order = 3)]
        public double Catalog { get; set; }

        [DataMember(Name = "sqlConnection", Order = 4)]
        public double SqlConnection { get; set; }

        [DataMember(Name = "sqlExecution", Order = 5)]
        public double SqlExecution { get; set; }

        [DataMember(Name = "dataverseAction", Order = 6)]
        public double DataverseAction { get; set; }

        [DataMember(Name = "dataverseSettings", Order = 7)]
        public double DataverseSettings { get; set; }

        [DataMember(Name = "dataverseRequestBuild", Order = 8)]
        public double DataverseRequestBuild { get; set; }

        [DataMember(Name = "dataverseDependencyResolution", Order = 9)]
        public double DataverseDependencyResolution { get; set; }

        [DataMember(Name = "dataverseApiRoundtrip", Order = 10)]
        public double DataverseApiRoundtrip { get; set; }

        [DataMember(Name = "dataverseResponseMapping", Order = 11)]
        public double DataverseResponseMapping { get; set; }

        [DataMember(Name = "dataverseSegmentRetrieve", Order = 12)]
        public double DataverseSegmentRetrieve { get; set; }

        [DataMember(Name = "dataverseMqlParsing", Order = 13)]
        public double DataverseMqlParsing { get; set; }

        [DataMember(Name = "dataverseRelationshipMetadata", Order = 14)]
        public double DataverseRelationshipMetadata { get; set; }

        [DataMember(Name = "dataverseEntityMetadata", Order = 15)]
        public double DataverseEntityMetadata { get; set; }

        [DataMember(Name = "dataverseSegmentReferences", Order = 16)]
        public double DataverseSegmentReferences { get; set; }

        [DataMember(Name = "dataverseStaticMembers", Order = 17)]
        public double DataverseStaticMembers { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentQueryComplexity
    {
        [DataMember(Name = "stages", Order = 1)]
        public int Stages { get; set; }

        [DataMember(Name = "profileFilters", Order = 2)]
        public int ProfileFilters { get; set; }

        [DataMember(Name = "relationshipFilters", Order = 3)]
        public int RelationshipFilters { get; set; }

        [DataMember(Name = "consentFilters", Order = 4)]
        public int ConsentFilters { get; set; }

        [DataMember(Name = "interactionFilters", Order = 5)]
        public int InteractionFilters { get; set; }

        [DataMember(Name = "unions", Order = 6)]
        public int Unions { get; set; }

        [DataMember(Name = "exclusions", Order = 7)]
        public int Exclusions { get; set; }

        [DataMember(Name = "maximumDepth", Order = 8)]
        public int MaximumDepth { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentDiagnosticRuntime
    {
        [DataMember(Name = "cache", Order = 1)]
        public string Cache { get; set; }

        [DataMember(Name = "coalesced", Order = 2)]
        public bool Coalesced { get; set; }

        [DataMember(Name = "capacityState", Order = 3)]
        public string CapacityState { get; set; }

        [DataMember(Name = "businessUnitScoping", Order = 4)]
        public bool BusinessUnitScoping { get; set; }

        [DataMember(Name = "retries", Order = 5)]
        public int Retries { get; set; }

        [DataMember(Name = "requestBuildCache", Order = 6)]
        public string RequestBuildCache { get; set; }
    }

    [DataContract]
    internal sealed class FabricSegmentDiagnosticIdentifiers
    {
        [DataMember(Name = "subscriptionId", Order = 1)]
        public string SubscriptionId { get; set; }

        [DataMember(Name = "resourceGroup", Order = 2)]
        public string ResourceGroup { get; set; }

        [DataMember(Name = "workspaceId", Order = 3)]
        public string WorkspaceId { get; set; }

        [DataMember(Name = "lakehouseId", Order = 4)]
        public string LakehouseId { get; set; }
    }
}
