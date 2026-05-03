const express = require('express');
const Groq = require('groq-sdk');
const NaturalLanguageUnderstandingV1 = require('ibm-watson/natural-language-understanding/v1');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// IBM Watson NLU
const nlu = new NaturalLanguageUnderstandingV1({
  version: '2022-04-07',
  authenticator: new IamAuthenticator({ apikey: process.env.IBM_NLU_KEY }),
  serviceUrl: process.env.IBM_NLU_URL,
});

// IBM Cloudant
const cloudant = CloudantV1.newInstance({
  authenticator: new IamAuthenticator({ apikey: process.env.IBM_CLOUDANT_KEY }),
  serviceUrl: process.env.IBM_CLOUDANT_URL,
});

const DB_NAME = 'nova-chats';

// Create DB if not exists
async function initDB() {
  try {
    await cloudant.getDatabaseInformation({ db: DB_NAME });
    console.log('✅ Cloudant DB connected');
  } catch (e) {
    try {
      await cloudant.putDatabase({ db: DB_NAME });
      console.log('✅ Cloudant DB created');
    } catch (err) {
      console.log('⚠️ Cloudant not configured yet');
    }
  }
}

app.use(express.json());
app.use(express.static('public'));

// MAIN CHAT ROUTE
app.post('/chat', async (req, res) => {
  const { message, chatId, userEmail } = req.body;
  try {
    // 1. Get AI response from Groq
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: message }],
    });
    const reply = response.choices[0].message.content;

    // 2. Analyze with IBM Watson NLU
    let analysis = null;
    try {
      const nluResult = await nlu.analyze({
        text: message,
        features: {
          sentiment: {},
          keywords: { limit: 3 },
          categories: { limit: 1 },
        },
      });
      analysis = {
        sentiment: nluResult.result.sentiment?.document?.label || 'neutral',
        sentimentScore: nluResult.result.sentiment?.document?.score || 0,
        keywords: nluResult.result.keywords?.map(k => k.text) || [],
        category: nluResult.result.categories?.[0]?.label || '',
      };
    } catch (nluErr) {
      console.log('⚠️ NLU analysis skipped:', nluErr.message);
    }

    // 3. Save to IBM Cloudant
    try {
      await cloudant.postDocument({
        db: DB_NAME,
        document: {
          chatId: chatId || 'default',
          userEmail: userEmail || 'anonymous',
          userMessage: message,
          botReply: reply,
          analysis: analysis,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (dbErr) {
      console.log('⚠️ Cloudant save skipped:', dbErr.message);
    }

    res.json({ reply, analysis });
  } catch (error) {
    console.error('ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET CHAT HISTORY FROM CLOUDANT
app.get('/history/:email', async (req, res) => {
  try {
    const result = await cloudant.postFind({
      db: DB_NAME,
      selector: { userEmail: req.params.email },
      sort: [{ timestamp: 'desc' }],
      limit: 50,
    });
    res.json({ chats: result.result.docs });
  } catch (err) {
    res.json({ chats: [] });
  }
});

initDB();
app.listen(3000, () => console.log('✅ Server running on http://localhost:3000'));