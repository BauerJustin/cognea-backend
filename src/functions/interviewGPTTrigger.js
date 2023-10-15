const { app } = require("@azure/functions");
const { Configuration, OpenAIApi } = require("openai");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require("os");


const openai_configuration = new Configuration({
    organization: process.env.OPENAI_ORGANIZATION,
    apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(openai_configuration);

const interviews = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY
}).database("interviews");

app.http('interviewGPTTrigger', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request) => {
        const message_json = await request.json();

        let session_container = "sessions";
        let session_data = {
            messages: []
        };
        if (message_json.interview.state === 'start_interview') {
            let start_time = new Date().getTime()
            session_data  = {
                session_id: uuidv4(),
                username: message_json.metadata.username,
                given_name: message_json.metadata.given_name,
                localAccountId: message_json.metadata.localAccountId,
                userAgent: message_json.metadata.userAgent,
                start_time: start_time, // ms
                company: message_json.interview.company,
                job_title: message_json.interview.job_title,
                job_description: message_json.interview.job_description,
                candidate_background: message_json.interview.candidate_background,
                messages: []
            };
            session_data.messages.push({
                role: "system",
                content: `You are Cognea, an AI assistant that helps people practice for interviews; Today you are interviewing ${session_data.given_name} to be a ${session_data.job_title} at ${session_data.company}; The responsibilities for this job include ${session_data.job_description} and ${session_data.given_name} has the following background: ${session_data.candidate_background}; You will help them prep for their interview by pretending to be the hiring manager interviewing them; Make sure to ask follow up questions on each question; Be concise in your questions and follow ups; At any point the user or you end the interview, always instruct the user to click the "End Interview" button.`
            });
            session_data.messages.push({
                role: "user",
                content: `Hi Cognea, I am ${session_data.given_name}. Please interview me for the ${session_data.job_title} role at ${session_data.company}. The job description includes the following information: ${session_data.job_description}; My background includes: ${session_data.candidate_background}. Please pretend this an actual interview and interview me, one question at a time. If at any time you or I end the interview, always instruct me to click the "End Interview" button;`
            });

            interviews.container(session_container).items.create(session_data);
        } else {
            session_container = message_json.metadata.session_container;
            let { resource: resource } = await interviews.container(session_container).item(message_json.metadata.id, message_json.metadata.session_id).read();
            session_data = resource;

            if (message_json.interview.state === 'user_feedback') {
                session_data.feedback = message_json.feedback;
                session_data.rating = message_json.rating;

                interviews.container(session_container).item(session_data.id, session_data.session_id).replace(session_data);

                return { jsonBody: {
                    state: "success"
                }};
            }

            if ('candidate_response' in message_json.interview) {
                let fileExt = '';
                if (message_json.interview.candidate_response.includes('audio/wav')) {
                    fileExt = 'wav';
                } else if (message_json.interview.candidate_response.includes('audio/webm')) {
                    fileExt = 'webm';
                } else {
                    return { jsonBody: {
                        state: "invalid_audio_file_type",
                        type: message_json.interview.candidate_response.split(';')[0]
                    }};
                }
                const audioData = message_json.interview.candidate_response.replace(`data:audio/${fileExt};`, '').replace('codecs=opus;', '').replace('base64,', '');
                const audioBufferBase64 = Buffer.from(audioData, 'base64');

                const filePath = path.join(os.tmpdir(), `audio.${fileExt}`);
                fs.writeFileSync(filePath, audioBufferBase64);
                const audioFile = fs.createReadStream(filePath);

                const whisperRes = await openai.createTranscription(
                    file=audioFile,
                    model="whisper-1"
                )

                console.log(whisperRes.data.text)
                message_json.interview.candidate_response = whisperRes.data.text;
                message_json.interview.candidate_response = message_json.interview.candidate_response.replace('Cognia', 'Cognea').replace('cognia', 'cognea');
            }

            if (message_json.interview.state === 'end_interview') {
                let end_time = new Date().getTime()
                session_data.end_time = end_time;
                if (session_data.messages.length <= 3 && 'candidate_response' in message_json.interview === false) {  // When no questions were answered
                    return { jsonBody: {
                        id: session_data.id,
                        session_id: session_data.session_id,
                        state: "response",
                        ai_response: "Interview ended. No questions answered to provide any feedback.",
                    }};
                }
                let candidate_response_prompt = 'candidate_response' in message_json.interview ? `${message_json.interview.candidate_response};` : ""
                session_data.messages.push({
                    role: "user",
                    content: `${candidate_response_prompt}\nPlease end the interview now. Please provide me personalized feedback on what I did well and how I can improve.`
                })
            } else if (message_json.interview.state === 'candidate_response') {
                session_data.messages.push({
                    role: "user",
                    content: `${message_json.interview.candidate_response}`
                })
            } else {
                return { jsonBody: {
                    state: "invalid"
                }};
            }
            interviews.container(session_container).item(session_data.id, session_data.session_id).replace(session_data);
        }

        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: session_data.messages
        })

        const ai_response = completion.data.choices[0].message
        session_data.messages.push(ai_response)

        interviews.container(session_container).item(session_data.id, session_data.session_id).replace(session_data);

        return { jsonBody: {
            id: session_data.id,
            session_id: session_data.session_id,
            session_container: session_container,
            state: "response",
            ai_response: ai_response.content,
        }};
    }
});
