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

@description('HTTPS URL of the published Segment Preview API package. Empty leaves the Web App without a package.')
param apiPackageUrl string = ''

@description('SHA-256 of the published API package, 64 lower-case hexadecimal characters. Required together with apiPackageUrl.')
param apiPackageSha256 string = ''

@description('Immutable blob name the verified package is stored under. Empty derives it from the digest.')
param apiPackageBlobName string = ''

@description('Version stamped into the Web App settings alongside the package.')
param apiPackageVersion string = ''

@description('Storage account that holds the customer-owned copy of the API package. Empty derives a deterministic name.')
param packageStorageAccountName string = ''

// A package is only deployed when the caller pinned both the URL and the digest.
// Without the digest the copy could not be verified, so nothing is created.
var deployPackage = !empty(apiPackageUrl) && !empty(apiPackageSha256)
var storageName = empty(packageStorageAccountName)
  ? toLower('sp${take(replace(webAppName, '-', ''), 11)}${take(uniqueString(resourceGroup().id, webAppName), 11)}')
  : packageStorageAccountName
var containerName = 'segment-preview-api'
var blobName = empty(apiPackageBlobName)
  ? 'api-${take(apiPackageSha256, 16)}.zip'
  : apiPackageBlobName
var packageBlobUrl = 'https://${storageName}.blob.${environment().suffixes.storage}/${containerName}/${blobName}'
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var privateBlobDnsZoneName = 'privatelink.blob.${environment().suffixes.storage}'

resource packageVnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${webAppName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'package-copy'
        properties: {
          addressPrefix: '10.42.0.0/24'
          delegations: [
            {
              name: 'aci'
              properties: {
                serviceName: 'Microsoft.ContainerInstance/containerGroups'
              }
            }
          ]
        }
      }
      {
        name: 'web-app'
        properties: {
          addressPrefix: '10.42.1.0/24'
          delegations: [
            {
              name: 'app-service'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.42.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource packageCopySubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  name: 'package-copy'
  parent: packageVnet
}

resource webAppSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  name: 'web-app'
  parent: packageVnet
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  name: 'private-endpoints'
  parent: packageVnet
}

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

// The API package is copied into a storage account in this resource group and
// the Web App reads it with its own managed identity. Nothing in the running
// system points at a publisher-hosted URL, and no shared key or SAS is issued.
resource packageStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (deployPackage) {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource privateBlobDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (deployPackage) {
  name: privateBlobDnsZoneName
  location: 'global'
}

resource privateBlobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (deployPackage) {
  parent: privateBlobDnsZone
  name: '${webAppName}-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: packageVnet.id
    }
  }
}

resource packagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (deployPackage) {
  name: '${webAppName}-package-blob'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: packageStorage.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource packagePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (deployPackage) {
  parent: packagePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: privateBlobDnsZone.id
        }
      }
    ]
  }
}

resource packageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (deployPackage) {
  name: '${storageName}/default/${containerName}'
  properties: {
    publicAccess: 'None'
  }
  dependsOn: [
    packageStorage
  ]
}

// The copy container runs under an identity that exists only for this purpose
// and only has data-plane write access to the package storage account.
resource packageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (deployPackage) {
  name: '${webAppName}-package'
  location: location
}

resource packageWriteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployPackage) {
  name: guid(resourceGroup().id, storageName, 'package-writer')
  scope: packageStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    #disable-next-line BCP318
    principalId: packageIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource packageCopy 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = if (deployPackage) {
  name: '${webAppName}-package-copy'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      #disable-next-line BCP318
      '${packageIdentity.id}': {}
    }
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    subnetIds: [
      {
        id: packageCopySubnet.id
      }
    ]
    containers: [
      {
        name: 'copy'
        properties: {
          image: 'mcr.microsoft.com/azure-cli:2.61.0'
          command: [
            '/bin/sh'
            '-c'
            'printf "%s" "$1" | tr -d "\\r" | /bin/sh -e'
            'copy-script'
            '''
work=$(mktemp -d)
az login --identity --allow-no-subscriptions --output none

exists=false
for attempt in $(seq 1 30); do
  if az storage blob exists --auth-mode login --account-name "$ACCOUNT" \
      --container-name "$CONTAINER" --name "$BLOB" --only-show-errors \
      --query exists -o tsv > "$work/exists" 2>"$work/err"; then
    exists=$(tr -d '[:space:]' < "$work/exists" | tr '[:upper:]' '[:lower:]')
    break
  fi
  echo "Waiting for the role assignment to take effect (attempt $attempt)."
  sleep 10
done

if [ "$exists" = "true" ]; then
  echo "The verified package is already stored as $BLOB; nothing is copied."
else
  python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' \
    "$PACKAGE_URL" "$work/package.zip"
  actual=$(sha256sum "$work/package.zip" | cut -d' ' -f1)
  if [ "$actual" != "$PACKAGE_SHA256" ]; then
    echo "The downloaded package does not match the pinned digest." >&2
    echo "expected $PACKAGE_SHA256, got $actual" >&2
    exit 1
  fi
  az storage blob upload --auth-mode login --account-name "$ACCOUNT" \
    --container-name "$CONTAINER" --name "$BLOB" --file "$work/package.zip" \
    --overwrite false --only-show-errors
  echo "Copied the verified package to $BLOB."
fi

echo "Verified package copy completed."
'''
          ]
          environmentVariables: [
            {
              name: 'PACKAGE_URL'
              value: apiPackageUrl
            }
            {
              name: 'PACKAGE_SHA256'
              value: toLower(apiPackageSha256)
            }
            {
              name: 'ACCOUNT'
              value: storageName
            }
            {
              name: 'CONTAINER'
              value: containerName
            }
            {
              name: 'BLOB'
              value: blobName
            }
          ]
          resources: {
            requests: {
              cpu: 1
              memoryInGB: 1
            }
          }
        }
      }
    ]
  }
  dependsOn: [
    packageContainer
    packageWriteRole
    packagePrivateDnsGroup
  ]
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
    virtualNetworkSubnetId: webAppSubnet.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      vnetRouteAllEnabled: true
      minTlsVersion: '1.2'
      linuxFxVersion: 'DOTNETCORE|8.0'
      healthCheckPath: '/api/health'
      appSettings: concat([
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
      ], deployPackage ? [
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: packageBlobUrl
        }
        {
          // The Web App reads the package with its own system-assigned identity,
          // so no SAS is issued and nothing expires.
          name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID'
          value: 'SystemAssigned'
        }
        {
          name: 'SEGMENT_PREVIEW_PACKAGE_VERSION'
          value: apiPackageVersion
        }
        {
          name: 'SEGMENT_PREVIEW_PACKAGE_SHA256'
          value: toLower(apiPackageSha256)
        }
      ] : [])
    }
  }
  // The site must not start before the package blob exists, otherwise it boots
  // once against a missing blob and has to be restarted to recover.
  dependsOn: deployPackage ? [packageCopy] : []
}

resource packageReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployPackage) {
  name: guid(resourceGroup().id, storageName, webAppName, 'package-reader')
  scope: packageStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}/api/'
output managedIdentityPrincipalId string = webApp.identity.principalId
output applicationInsightsName string = applicationInsights.name
output packageBlobUrl string = deployPackage ? packageBlobUrl : ''
output packageStorageAccount string = deployPackage ? storageName : ''
output packageBlob string = deployPackage ? blobName : ''
