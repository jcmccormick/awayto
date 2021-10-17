import path from 'path';
import fs from 'fs';
import fse from 'fs-extra';
import archiver from 'archiver';
import child_process from 'child_process';
import { URL } from 'url';

import { RDSClient, ModifyDBInstanceCommand, CreateDBInstanceCommand, DescribeOrderableDBInstanceOptionsCommand, DescribeDBInstancesCommand, RestoreDBClusterFromS3Command, RestoreDBInstanceFromDBSnapshotCommand } from '@aws-sdk/client-rds';
import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2'
import { SSMClient, DescribeParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, CreateBucketCommand, ListBucketsCommand, PutObjectCommand, PutBucketWebsiteCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand, InvokeCommand } from '@aws-sdk/client-lambda';

import { ask, replaceText, asyncForEach, makeLambdaPayload } from './tool.mjs';
import regions from './data/regions.mjs';
  
const rdsClient = new RDSClient();
const ec2Client = new EC2Client();
const ssmClient = new SSMClient();
const iamClient = new IAMClient();
const s3Client = new S3Client();
const cfClient = new CloudFormationClient();
const lamClient = new LambdaClient();

export default async function () {

  const __dirname = path.dirname(fs.realpathSync(new URL(import.meta.url)));

  const config = {
    name: await ask('Project Name (\'awayto\'):\n> ', /^[a-zA-Z0-9]*$/) || 'awayto',
    description: await ask('Project Description (\'Awayto is a workflow enhancing platform, producing great value with minimal investment.\'):\n> ') || 'Awayto is a workflow enhancing platform, producing great value with minimal investment.',
    environment: await ask('Environment (\'dev\'):\n> ') || 'dev',
    username: await ask('DB Username (\'postgres\'):\n> ') || 'postgres',
    password: await ask('DB Password 8 char min (\'postgres\'):\n> ', /[@"\/]/) || 'postgres',
    regionId: await ask(`${regions.map((r, i) => `${i}. ${r}`).join('\n')}\nChoose a number (0. us-east-1):\n> `) || '0'
  };

  const region = regions[parseInt(config.regionId)];

  const azCommand = new DescribeAvailabilityZonesCommand({
    Filters: [{
      Name: 'region-name',
      Values: [region]
    }]
  })

  const { AvailabilityZones } = await ec2Client.send(azCommand);
  const { ZoneName } = AvailabilityZones[await ask(`${AvailabilityZones.map((r, i) => `${i}. ${r.ZoneName}`).join('\n')}\nChoose a number (0. default):\n> `) || '0']

  // Generate uuids
  const seed = (new Date).getTime();
  const id = `${config.name}${config.environment}${seed}`;
  const username = config.username;
  const password = config.password;

  console.log('== Beginning Awayto Install: ' + id);

  // Create Amazon RDS instance
  const createRdsInstance = async () => {

    console.log('Beginning DB instance creation.');
  
    // Get all available AWS db engines for Postgres
    const instanceTypeCommand = new DescribeOrderableDBInstanceOptionsCommand({
      Engine: 'postgres'
    });
  
    const instanceTypeResponse = await rdsClient.send(instanceTypeCommand);
    
    // We only want to create a t2.micro standard type DB as this is AWS free tier
    const { Engine, EngineVersion } = instanceTypeResponse.OrderableDBInstanceOptions.find(o => o.DBInstanceClass == 'db.t2.micro' && o.StorageType == 'standard');

    const createCommand = new CreateDBInstanceCommand({
      DBInstanceClass: 'db.t2.micro',
      DBInstanceIdentifier: id,
      Engine,
      EngineVersion,
      AllocatedStorage: 10,
      MaxAllocatedStorage: 20,
      BackupRetentionPeriod: 0,
      DBName: id, // TODO custom name management; of multi db instances
      DeletionProtection: false,
      MasterUsername: username,
      MasterUserPassword: password,
      PubliclyAccessible: false,
      AvailabilityZone: ZoneName
    });

    // Start DB creation -- will take time to fully generate
    await rdsClient.send(createCommand);

    // console.log('Created a new DB Instance: ' + id + ' \nYou can undo this action with the following command: \n\naws rds delete-db-instance --db-instance-identifier ' + id + ' --skip-final-snapshot');

    // console.log('Waiting for DB creation (~5-10 mins).'); // TODO -- refactor usage of SSM params to avoid "having" to wait for this
    // await pollDBStatusAvailable(id);

  }

  await createRdsInstance();
  // const dbInstance = await pollDBStatusAvailable(id);

  // Create SSM Parameters
  // Create the following string parameters in the Parameter Store:
  // PGDATABASE (postgres)
  // PGHOST
  // PGPASSWORD
  // PGPORT (5432)
  // PGUSER (postgres)

  const createSsmParameters = async () => {
    await ssmClient.send(new PutParameterCommand({
      Name: 'PGHOST_' + id,
      Value: 'tempvalue',
      DataType: 'text',
      Type: 'String'
    }));
    await ssmClient.send(new PutParameterCommand({
      Name: 'PGPORT_' + id,
      Value: '5432',
      DataType: 'text',
      Type: 'String'
    }));
    await ssmClient.send(new PutParameterCommand({
      Name: 'PGUSER_' + id,
      Value: username,
      DataType: 'text',
      Type: 'String'
    }));
    await ssmClient.send(new PutParameterCommand({
      Name: 'PGPASSWORD_' + id,
      Value: password,
      DataType: 'text',
      Type: 'String'
    }));
    await ssmClient.send(new PutParameterCommand({
      Name: 'PGDATABASE_' + id,
      Value: 'postgres',
      DataType: 'text',
      Type: 'String'
    }));
  }

  console.log('Creating SSM parameters.');
  await createSsmParameters();

  // Create LambdaTrust IAM Role with following AWS-Managed policies:
  // AmazonS3FullAccess
  // CloudWatchLogsFullAccess
  // AmazonCognitoDeveloperAuthenticatedIdentities
  // AmazonCognitoPowerUser
  // AWSLambdaBasicExecutionRole
  // AWSIoTFullAccess
  // AWSConfigRulesExecutionRole
  // AWSLambdaVPCAccessExecutionRole

  const roleName = 'LambdaTrust';

  const createLambdaRole = async () => {
    try {

      await iamClient.send(new GetRoleCommand({
        RoleName: roleName
      }));

    } catch (error) {

      console.log('creating role ' + roleName);

      await iamClient.send(new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: `{
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Principal": {
                "Service": "lambda.amazonaws.com"
              },
              "Action": "sts:AssumeRole"
            }
          ]
        }`
      }));

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/CloudWatchFullAccess'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AmazonCognitoDeveloperAuthenticatedIdentities'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AmazonCognitoPowerUser'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AWSIoTFullAccess'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSConfigRulesExecutionRole'
      }))

      await iamClient.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
      }))

    }
  }

  console.log('Creating LambdaTrust role.');
  await createLambdaRole();

  // Create two S3 buckets and put src/api/scripts/lambda.zip in one:
  // s3://<some-name>-lambda/lambda.zip
  // s3://<some-name>-webapp

  fs.copyFileSync(path.join(__dirname, 'data/template.yaml.template'), path.join(__dirname, 'data/template.yaml'))
  await replaceText(path.join(__dirname, 'data/template.yaml'), 'id', id);

  await s3Client.send(new CreateBucketCommand({ Bucket: id + '-lambda' }));
  await s3Client.send(new CreateBucketCommand({ Bucket: id + '-webapp' }));
  await s3Client.send(new PutObjectCommand({
    Bucket: id + '-lambda',
    Key: 'lambda.zip',
    Body: fs.readFileSync(path.join(__dirname, 'data/lambda.zip'))
  }));
  await s3Client.send(new PutObjectCommand({
    Bucket: id + '-lambda',
    Key: 'template.yaml',
    Body: fs.readFileSync(path.join(__dirname, 'data/template.yaml'))
  }));

  await s3Client.send(new PutBucketWebsiteCommand({
    Bucket: id + '-webapp',
    WebsiteConfiguration: {
      IndexDocument: {
        Suffix: 'index.html'
      }
    }
  }))

  await s3Client.send(new PutBucketPolicyCommand({
    Bucket: id + '-webapp',
    Policy: `{
      "Version": "2008-10-17",
      "Statement": [
        {
          "Sid": "AllowPublicRead",
          "Effect": "Allow",
          "Principal": "*",
          "Action": "s3:GetObject",
          "Resource": "arn:aws:s3:::${id + '-webapp'}/*"
        }
      ]
    }`
  }))

  await cfClient.send(new CreateStackCommand({
    StackName: id,
    TemplateURL: 'https://' + id + '-lambda.s3.amazonaws.com/template.yaml',
    Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    OnFailure: 'DELETE',
    Parameters: [
      {
        ParameterKey: 'Environment',
        ParameterValue: 'dev'
      }
    ]
  }))

  console.log('Deploying CloudFormation stack.');

  await pollStackCreated(id);

  const resourceResponse = await cfClient.send(new ListStackResourcesCommand({ StackName: id }));

  const resources = resourceResponse.StackResourceSummaries.map(r => {
    return {
      [r.LogicalResourceId]: r.PhysicalResourceId
    };
  }).reduce((a, b) => Object.assign(a, b), {});

  const awaytoConfig = {
    awaytoId: id,
    name: config.name,
    description: config.description,
    environment: config.environment,
    seed,
    awsRegion: region,
    functionName: resources[id + 'Resource'],
    cognitoUserPoolId: resources['CognitoUserPool'],
    cognitoClientId: resources['CognitoUserPoolClient'],
    apiGatewayEndpoint: `https://${resources[id + 'ResourceApi']}.execute-api.${region}.amazonaws.com/${resources[id + 'ResourceApiStage']}/`,
    website: `http://${id + '-webapp'}.s3-website.${region}.amazonaws.com`
  }

  createSeed(__dirname, awaytoConfig);

  const copyFiles = [
    'src',
    'public',
    'apipkg',
    '.env',
    '.babelrc',
    '.eslintignore',
    '.eslintrc',
    'api.paths.json',
    'api.ts.json',
    'api.webpack.js',
    'config-overrides.js',
    'package.json',
    'settings.application.env',
    'tsconfig.json',
    'tsconfig.paths.json'
  ];

  copyFiles.forEach(file => {
    fse.copySync(path.resolve(__dirname, `../app/${file}`), path.resolve(process.cwd(), file));
  })

  const tmplFiles = [
    '.gitignore',
    'public/index.html',
    'settings.development.env',
    'settings.production.env'
  ];

  tmplFiles.forEach(file => {
    fse.copySync(path.resolve(__dirname, `../app/${file}.template`), path.resolve(process.cwd(), file));
  })

  console.log('Applying properties to settings file.');

  const varFiles = [
    'package.json',
    'public/index.html',
    'public/manifest.json',
    'settings.development.env',
    'settings.production.env'
  ];

  await asyncForEach(varFiles, async file => {
    await asyncForEach(Object.keys(awaytoConfig), async cfg => {
      await replaceText(path.resolve(process.cwd(), file), cfg, awaytoConfig[cfg]);
    })
  });

  try {
    console.log('Performing npm install.')
    child_process.execSync(`npm i`);
    child_process.execSync(`npm i --prefix ./apipkg`);
  } catch (error) {
    console.log('npm install failed')
  }

  try {
    console.log('Building webapp and api.')
    child_process.execSync(`npm run build`);
  } catch (error) {
    console.log('webapp build failed')
  }

  try {
    console.log('Syncing webapp to S3.')
    child_process.execSync(`aws s3 sync ./build s3://${id + '-webapp'}`);
  } catch (error) {
    console.log('webapp sync failed')
  }

  try {
    console.log('Deploying api to Lambda.')

    const output = fs.createWriteStream('lambda.zip');
    const archive = archiver('zip');

    archive.on('error', function (error) {
      throw error;
    });

    archive.pipe(output);
    archive.directory('apipkg/', false);

    output.on('close', async function() {
      child_process.execSync(`aws s3 cp ./lambda.zip s3://${id + '-lambda'}`);
      child_process.execSync(`aws lambda update-function-code --function-name ${config.environment}-${region}-${id}Resource --region ${region} --s3-bucket ${id + '-lambda'} --s3-key lambda.zip`);
      child_process.execSync(`rm lambda.zip`);

      console.log('Checking DB availability.');
      const dbInstance = await pollDBStatusAvailable(id);

      console.log('Updating DB password.');
      await rdsClient.send(new ModifyDBInstanceCommand({
        DBInstanceIdentifier: id,
        MasterUserPassword: password
      }));

      console.log('Waiting for DB to be ready.');
      await pollDBStatusAvailable(id);

      const lamCfgCommand = await lamClient.send(new GetFunctionConfigurationCommand({
        FunctionName: awaytoConfig.functionName
      }));
  
      let envVars = Object.assign({}, lamCfgCommand.Environment.Variables);
      envVars['PGHOST'] = dbInstance.Endpoint.Address;
  
      await lamClient.send(new UpdateFunctionConfigurationCommand({
        FunctionName: awaytoConfig.functionName,
        Environment: {
          Variables: envVars
        }
      }));

      await lamClient.send(new InvokeCommand({
        FunctionName: awaytoConfig.functionName,
        InvocationType: 'Event',
        Payload: makeLambdaPayload({
          "httpMethod": "GET",
          "pathParameters": {
            "proxy": "deploy"
          },
          "body": {}
        })
      }));

      await ssmClient.send(new PutParameterCommand({
        Name: 'PGHOST_' + id,
        Value: dbInstance.Endpoint.Address,
        DataType: 'text',
        Type: 'String',
        Overwrite: true
      }));

      console.log(`Site available at ${awaytoConfig.website}.`)
      process.exit();
    });

    await archive.finalize();
  } catch (error) {
    console.log('api deploy failed')
  }

};

const pollStackCreated = (id) => {

  const loader = makeLoader();
  const describeCommand = new DescribeStacksCommand({
    StackName: id
  });

  const executePoll = async (resolve, reject) => {
    try {
      const response = await cfClient.send(describeCommand);
      const instance = response.Stacks[0];

      if (instance.StackStatus.toLowerCase() == 'create_complete') {
        clearInterval(loader);
        process.stdout.write("\r\x1b[K")
        return resolve(instance);
      } else {
        setTimeout(executePoll, 10000, resolve, reject);
      }
    } catch (error) {
      return reject(error);
    }
  }

  return new Promise(executePoll);
}

const pollDBStatusAvailable = (id) => {

  const loader = makeLoader();
  const describeCommand = new DescribeDBInstancesCommand({
    DBInstanceIdentifier: id
  });

  const executePoll = async (resolve, reject) => {
    try {
      const response = await rdsClient.send(describeCommand);
      const instance = response.DBInstances[0];

      if (instance.DBInstanceStatus.toLowerCase() == 'available') {
        clearInterval(loader);
        process.stdout.write("\r\x1b[K")
        return resolve(instance);
      } else {
        setTimeout(executePoll, 10000, resolve, reject);
      }
    } catch (error) {
      return reject(error);
    }
  }

  return new Promise(executePoll);
};

const makeLoader = () => {
  let counter = 1;
  return setInterval(function () {
    process.stdout.write("\r\x1b[K")
    process.stdout.write(`${counter % 2 == 0 ? '-' : '|'}`);
    counter++;
  }, 250)
}

const createSeed = (dir, config) => {
  fs.writeFileSync(path.join(dir, `data/seeds/${config.awaytoId}.json`), JSON.stringify(config));
  console.log('Generated project seed.');
}