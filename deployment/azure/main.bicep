targetScope = 'resourceGroup'

@description('Azure region used for the Segment Preview resources.')
param location string = resourceGroup().location

@description('Globally unique Azure Web App name.')
param webAppName string

@description('Fabric SQL endpoint host name.')
param fabricSqlServer string

@description('Fabric SQL endpoint database name.')
param fabricSqlDatabase string

@description('Fabric workspace ID.')
param fabricWorkspaceId string

@description('Fabric Serving Lakehouse ID.')
param fabricServingLakehouseId string

@description('Fabric cloud connection ID for the Dataverse source.')
param fabricDataverseConnectionId string

@description('Dataverse Delta Lake folder used by the Fabric cloud connection.')
param fabricDataverseDeltaFolder string

@description('Dataverse environment URL.')
param dataverseEnvironmentUrl string

@secure()
@description('Shared secret accepted only by the server-side Segment Preview API.')
param behavioralApiKey string

@description('Required Dataverse shortcuts provisioned by the setup center.')
param requiredDataverseTables string = 'contact,msdynmkt_contactpointconsent4,msdynmkt_purpose,msdynmkt_topic'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${webAppName}-logs'
  location: location
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${webAppName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${webAppName}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    size: 'B1'
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      linuxFxVersion: 'DOTNETCORE|8.0'
      healthCheckPath: '/api/health'
      appSettings: [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsights.properties.ConnectionString
        }
        {
          name: 'ApplicationInsightsAgent_EXTENSION_VERSION'
          value: '~3'
        }
        {
          name: 'ASPNETCORE_ENVIRONMENT'
          value: 'Production'
        }
        {
          name: 'BEHAVIORAL_API_KEY'
          value: behavioralApiKey
        }
        {
          name: 'FABRIC_SQL_SERVER'
          value: fabricSqlServer
        }
        {
          name: 'FABRIC_SQL_DATABASE'
          value: fabricSqlDatabase
        }
        {
          name: 'FABRIC_WORKSPACE_ID'
          value: fabricWorkspaceId
        }
        {
          name: 'FABRIC_SERVING_LAKEHOUSE_ID'
          value: fabricServingLakehouseId
        }
        {
          name: 'FABRIC_DATAVERSE_CONNECTION_ID'
          value: fabricDataverseConnectionId
        }
        {
          name: 'FABRIC_DATAVERSE_DELTA_FOLDER'
          value: fabricDataverseDeltaFolder
        }
        {
          name: 'DATAVERSE_ENVIRONMENT_URL'
          value: dataverseEnvironmentUrl
        }
        {
          name: 'SEGMENT_PREVIEW_REQUIRED_TABLES'
          value: requiredDataverseTables
        }
      ]
    }
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}/api/'
output managedIdentityPrincipalId string = webApp.identity.principalId
output applicationInsightsName string = applicationInsights.name
