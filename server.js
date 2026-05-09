const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-openidconnect');
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

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'nova-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// IBM App ID Strategy
passport.use('ibmappid', new Strategy({
  issuer: process.env.IBM_APPID_OAUTH_URL,
  authorizationURL: `${process.env.IBM_APPID_OAUTH_URL}/authorization`,
  tokenURL: `${process.env.IBM_APPID_OAUTH_URL}/token`,
  userInfoURL: `${process.env.IBM_APPID_OAUTH_URL}/userinfo`,
  clientID: process.env.IBM_APPID_CLIENT_ID,
  clientSecret: process.env.IBM_APPID_SECRET,
  callbackURL: 'http://localhost:3000/auth/callback',
  scope: 'openid email profile',
  skipUserProfile: false,
}, (issuer, profile, done) => {
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Auth middleware
function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── ROUTES ──

// Login page
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

// Start IBM App ID login
app.get('/auth/login', passport.authenticate('ibmappid'));

// Callback from IBM App ID
app.get('/auth/callback',
  passport.authenticate('ibmappid', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/');
  }
);

// Logout
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy();
    res.redirect('/login');
  });
});

// Get current user info
app.get('/auth/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      name: req.user.displayName || req.user._json?.name || 'User',
      email: req.user._json?.email || req.user.id || 'user@nova.ai'
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// Main chat page - protected
app.get('/', isLoggedIn, (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Chat API - protected
app.post('/chat', isLoggedIn, async (req, res) => {
  const { message, chatId } = req.body;
  const userEmail = req.user._json?.email || req.user.id || 'anonymous';

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: message }],
    });
    const reply = response.choices[0].message.content;

    // IBM Watson NLU
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
      console.log('⚠️ NLU skipped:', nluErr.message);
    }

    // Save to Cloudant
    try {
      await cloudant.postDocument({
        db: DB_NAME,
        document: {
          chatId: chatId || 'default',
          userEmail,
          userMessage: message,
          botReply: reply,
          analysis,
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

initDB();
app.listen(3000, () => console.log('✅ Server running on http://localhost:3000'));