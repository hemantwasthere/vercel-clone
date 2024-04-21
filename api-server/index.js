const express = require("express");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const cors = require("cors");
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@clickhouse/client");
const { Kafka } = require("kafkajs");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 9000;

const kafka = new Kafka({
  clientId: `api-server`,
  brokers: [""],
  ssl: {
    ca: [fs.readFileSync(path.join(__dirname, "kafka.cer"), "utf-8")],
  },
  sasl: {
    username: "",
    password: "",
    mechanism: "plain",
  },
});

const client = new createClient({
  host: "",
  username: "",
  password: "",
  database: "default",
});

const consumer = kafka.consumer({ groupId: "api-server-logs-consumer" });

const prisma = new PrismaClient({});

const io = new Server({ cors: "*" });

io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", `Joined ${channel} channel`);
  });
});

io.listen(9002, () => console.log("Socket server is running on port 9002"));

const ecsClient = new ECSClient({
  region: "ap-south-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const config = {
  CLUSTER: "",
  TASK: "",
};

app.use(express.json());
app.use(cors());

app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitURL: z.string(),
  });

  const safeParseResult = schema.safeParse(req.body);

  if (safeParseResult.error)
    return res.status(400).json({ error: safeParseResult.error });

  const { name, gitURL } = safeParseResult.data;

  const project = await prisma.project.create({
    data: {
      name,
      gitURL,
      subDomain: generateSlug(),
    },
  });

  return res.json({ status: "success", data: { project } });
});

app.post("/deploy", async (req, res) => {
  const schema = z.object({
    projectId: z.string(),
  });

  const safeParseResult = schema.safeParse(req.body);

  if (!safeParseResult.success)
    return res.status(400).json({ error: safeParseResult.error });

  const { projectId } = safeParseResult.data;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) return res.status(404).json({ error: "Project not found" });

  // if there is no running deployment, create a new one
  const deployment = await prisma.deployments.create({
    data: {
      project: { connect: { id: projectId } },
      status: "QUEUED",
    },
  });

  // Spin up the container
  const command = new RunTaskCommand({
    cluster: config.CLUSTER,
    taskDefinition: config.TASK,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: ["", "", ""],
        securityGroups: [""],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "builder-image",
          environment: [
            {
              name: "GIT_REPOSITORY__URL",
              value: project.gitURL,
            },
            { name: "PROJECT_ID", value: projectId },
            { name: "DEPLOYMENT_ID", value: deployment.id },
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);

  return res.json({
    status: "queued",
    data: { deploymentId: deployment.id },
  });
});

app.get("/logs/:id", async (req, res) => {
  const id = req.params.id;
  const logs = await client.query({
    query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
    query_params: {
      deployment_id: id,
    },
    format: "JSONEachRow",
  });

  const rawLogs = await logs.json();

  return res.json({ logs: rawLogs });
});

async function initKafkaConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topic: "container-logs" });

  await consumer.run({
    autoCommit: false,
    eachBatch: async ({
      batch,
      heartbeat,
      commitOffsetsIfNecessary,
      resolveOffset,
    }) => {
      const messages = batch.messages;
      console.log("🚀 ~ initKafkaConsumer ~ messages:", messages);

      for (const message of messages) {
        const stringMessage = JSON.parse(message.value.toString());
        const { PROJECT_ID, DEPLOYMENT_ID, log } = stringMessage;

        try {
          const { query_id } = await client.insert({
            table: "log_events",
            values: [
              {
                event_id: uuidv4(),
                deployment_id: DEPLOYMENT_ID,
                log,
              },
            ],
            format: "JSONEachRow",
          });

          resolveOffset(message.offset);
          await commitOffsetsIfNecessary(message.offset);
          await heartbeat();
          console.log("🚀 ~ initKafkaConsumer ~ query_id:", query_id);
        } catch (error) {
          console.error("🚀 ~ initKafkaConsumer ~ error:", error);
        }
      }
    },
  });
}

initKafkaConsumer();

app.listen(PORT, () => {
  console.log(`API server is running on port ${PORT}`);
});
