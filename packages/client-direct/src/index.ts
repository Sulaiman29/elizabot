import bodyParser from "body-parser";
import cors from "cors";
import express, { Request as ExpressRequest } from "express";
import multer, { File } from "multer";
import { elizaLogger, generateCaption, generateImage } from "@ai16z/eliza";
import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import { AgentRuntime } from "@ai16z/eliza";
import {
    Content,
    Memory,
    ModelClass,
    Client,
    IAgentRuntime,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { settings } from "@ai16z/eliza";
import { createApiRouter } from "./api.ts";
import * as fs from "fs";
import * as path from "path";
import { runMain } from "module";
//import OpenAI from "openai";
import Anthropic from '@anthropic-ai/sdk';
//import { fetchSportsTweets } from "../../../agent/src/services/twitter/services.js";
const upload = multer({ storage: multer.memoryStorage() });
export const messageHandlerTemplate =
    // {{goals}}
    `# Areas of Expertise
{{knowledge}}
# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}
{{providers}}
{{characterPostExamples}}
{{postDirections}}
# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a 1-3 sentence post that is {{adjective}} about {{providers}} (without mentioning {{providers}} directly), from the perspective of {{agentName}}.You must include hashtags taken directly from {{providers}}. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 250 and more than 150   . No emojis. Use \\n\\n (double spaces) between statements..
` + messageCompletionFooter;
export interface SimliClientConfig {
    apiKey: string;
    faceID: string;
    handleSilence: boolean;
    videoRef: any;
    audioRef: any;
}
export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>;
    private server: any; // Store server instance
    constructor() {
        elizaLogger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
        const apiRouter = createApiRouter(this.agents);
        this.app.use(apiRouter);
        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file: File;
        }
        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;
                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }
                let runtime = this.agents.get(agentId);
                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }
                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }
                const formData = new FormData();
                const audioBlob = new Blob([audioFile.buffer], {
                    type: audioFile.mimetype,
                });
                formData.append("file", audioBlob, audioFile.originalname);
                formData.append("model", "whisper-1");
                const response = await fetch(
                    "https://api.openai.com/v1/audio/transcriptions",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${runtime.token}`,
                        },
                        body: formData,
                    }
                );
                const data = await response.json();
                res.json(data);
            }
        );
        this.app.post(
            "/:agentId/message",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");
                let runtime = this.agents.get(agentId);
                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }
                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }
                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );
                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());
                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };
                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };
                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };
                await runtime.messageManager.createMemory(memory);
                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });
                
                const temp = `You are an AI assistant designed to craft engaging and dynamic Twitter posts inspired by trending topics. Your style emulates a seasoned sports analyst with a bold, authoritative voice. You will first gather the latest trending posts from Twitter, specifically focusing on sports-related discussions, controversies, or highlights.
                                Using the character traits provided below, generate a unique and impactful Twitter post:
                                **Character Traits:**
                                - Authoritative and confident
                                - Knowledgeable about sports contracts, team dynamics, and player relationships
                                - Bold use of ALL CAPS for emphasis
                                - Passionate and unapologetic in opinions
                                - Witty catchphrases and dramatic declarations
                                **Post Requirements:**
                                1. Reference a trending sports topic or player.
                                2. Include ALL CAPS for emphasis on key points.
                                3. Use one of the provided introductory phrases (e.g., *"Hey Lets talk about...", "I think If I talk about...", "Okayy, so lets talk about..."*).
                                4. End with a signature catchphrase (e.g., *"BLASPHEMOUS!"* or *"STAY OFF THE WEED!"*).
                                5. Keep the tone passionate, dramatic, and confident.
                                **Example Output:**
                                "The DISRESPECT towards Steph Curry is ABSOLUTELY BLASPHEMOUS! This man REVOLUTIONIZED the game, and y'all still doubt him? STAY OFF THE WEED!"
                                Now, generate your response.

                                Generate ONLY the Twitter post without any extra recommendations, explanations, or details.

                                `
            
              
                let x = runtime.providers[3]
                let customProvider = await x.get(runtime,memory);
                let customCharater = runtime.character

            const anthropic = new Anthropic();
            
            const completion = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1024,
                temperature: 1,
                system: temp,
                messages: [
                    {
                    "role": "user",
                    "content": [
                        {
                        "type": "text",
                        "text": customProvider
                        }
                    ]
                    }
                ]
                });

            const response = completion.content[0]["text"];

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let customObject ={
                    customeCharacter:customCharater,
                    customProvider:customProvider,
                }
                if (0) {
                    res.json([response,customCharater,customProvider]);
                } else {
                    res.json({response,customObject});
                }
            }
        );
        this.app.post(
            "/:agentId/image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }
                const images = await generateImage({ ...req.body }, agent);
                const imagesRes: { image: string; caption: string }[] = [];
                if (images.data && images.data.length > 0) {
                    for (let i = 0; i < images.data.length; i++) {
                        const caption = await generateCaption(
                            { imageUrl: images.data[i] },
                            agent
                        );
                        imagesRes.push({
                            image: images.data[i],
                            caption: caption.title,
                        });
                    }
                }
                res.json({ images: imagesRes });
            }
        );
        this.app.post(
            "/fine-tune",
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );
                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;
                const downloadDir = path.join(
                    process.cwd(),
                    "downloads",
                    assetId
                );
                console.log("Download directory:", downloadDir);
                try {
                    console.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });
                    console.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );
                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
                        );
                    }
                    console.log("Response headers:", fileResponse.headers);
                    const fileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, "") || "default_name.txt";
                    console.log("Saving as:", fileName);
                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const filePath = path.join(downloadDir, fileName);
                    console.log("Full file path:", filePath);
                    await fs.promises.writeFile(filePath, buffer);
                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    console.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );
                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    console.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                        stack: error.stack,
                    });
                }
            }
        );
    }
    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }
    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }
    public start(port: number) {
        this.server = this.app.listen(port, () => {
            elizaLogger.success(`Server running at http://localhost:${port}/`);
        });
        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });
            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };
        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }
    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}
export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: any) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};
export default DirectClientInterface;