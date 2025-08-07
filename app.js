const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));

const PORT = process.env.REACT_APP_PORT || 10000;
const MONGODB_URI = process.env.REACT_APP_MONGO_URL;
const redisClient = require('./redisClient');

const client = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});

let db;

async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db('Climate');
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

async function ensureUniqueIndexes() {
  try {
    await db.collection('Consumers').createIndex({ email: 1 }, { unique: true });
  } catch (err) {
    console.error('Index creation error:', err);
  }
}

app.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const userId = crypto.randomUUID();
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      userid: userId,
      name,
      email: email.toLowerCase(), // Store email in lowercase
      phone,
      password: hashedPassword,
      resetTokenUsed: false,
      resetTokenTime: null,
      createdAt: new Date()
      // Removed lastLocation
    };

    const result = await db.collection('Consumers').insertOne(newUser);
    res.status(201).json({ 
      success: true, 
      message: 'Registration successful', 
    });
  } catch (err) {
    if (err.code === 11000) {
      if (err.keyPattern && err.keyPattern.email) {
        return res.status(409).json({ error: 'Email already registered.' });
      } else if (err.keyPattern && err.keyPattern.userId) {
        return res.status(409).json({ error: 'Registration conflict. Please try again.' });
      }
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const users = db.collection('Consumers');
    const { email, password } = req.body;

    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ error: "User Doesn't Exist" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    let sessionKey = user.sessionKey;
    let cachedUserData = null;

    if (sessionKey) {
      cachedUserData = await redisClient.get(sessionKey);
    }

    if (!cachedUserData) {
      // Create fresh user payload from database
      const userPayload = {
        name: user.name,
        email: user.email,
        phone: user.phone,
        userid: user.userid,
        createdAt: user.createdAt,
        resetTokenUsed: user.resetTokenUsed || false,
        resetTokenTime: user.resetTokenTime || null,
        // Removed lastLocation
      };

      sessionKey = crypto.createHash('sha256').update(JSON.stringify(userPayload)).digest('hex');

      await users.updateOne({ email: email.toLowerCase() }, { $set: { sessionKey } });

      // Set Redis expiry to 3 months (90 days)
      await redisClient.set(sessionKey, JSON.stringify(userPayload), {
        EX: 60 * 60 * 24 * 90, // 3 months = 90 days
      });
    }

    res.json({
      message: 'Login successful',
      sessionKey,
      success: true
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/userfromsession/:sessionKey', async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const cachedUserData = await redisClient.get(sessionKey);

    // If no Redis data, session expired
    if (!cachedUserData) {
      const users = db.collection('Consumers');
      await users.updateOne({ sessionKey }, { $unset: { sessionKey: "" } });
      
      return res.status(401).json({ 
        error: 'Session expired - please login again',
        expired: true,
        code: 'SESSION_EXPIRED'
      });
    }

    const cachedData = JSON.parse(cachedUserData);
    const users = db.collection('Consumers');
    const user = await users.findOne({ sessionKey });
    
    if (!user) {
      return res.status(401).json({ 
        error: 'Invalid session',
        expired: true 
      });
    }

    // Create fresh user payload from current database data
    const currentUserPayload = {
      name: user.name,
      email: user.email,
      phone: user.phone,
      userid: user.userid,
      createdAt: user.createdAt,
      resetTokenUsed: user.resetTokenUsed || false,
      resetTokenTime: user.resetTokenTime || null,
      // Removed lastLocation
    };

    // Check if any data has changed by comparing key fields
    const dataChanged = (
      cachedData.name !== currentUserPayload.name ||
      cachedData.email !== currentUserPayload.email ||
      cachedData.phone !== currentUserPayload.phone ||
      cachedData.resetTokenUsed !== currentUserPayload.resetTokenUsed ||
      cachedData.resetTokenTime !== currentUserPayload.resetTokenTime
    );

    if (dataChanged) {
      console.log('Data changed in database, updating Redis cache...');
      
      // Update Redis with fresh data from database
      await redisClient.del(sessionKey);
      await redisClient.set(sessionKey, JSON.stringify(currentUserPayload), {
        EX: 60 * 60 * 24 * 90, // 3 months
      });
      
      console.log('Redis cache updated with latest database data.');
      return res.json({ user: currentUserPayload });
    }

    // If no changes, return cached data
    return res.json({ user: cachedData });

  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Server error while fetching user.' });
  }
});

// Profile update endpoint
app.put('/updateprofile', async (req, res) => {
  try {
    const { sessionKey, name, phone } = req.body;
    
    const users = db.collection('Consumers');
    const user = await users.findOne({ sessionKey });
    if (!user) {
      return res.status(404).json({ error: 'Invalid session' });
    }
    const redisSession = await redisClient.get(sessionKey);
    if (!redisSession) {
      await users.updateOne({ sessionKey }, { $unset: { sessionKey: "" } });
      return res.status(401).json({ 
        error: 'Session expired - please login again',
        expired: true
      });
    }

    // Step 3: Proceed with profile update (if both checks pass)
    await users.updateOne(
      { sessionKey },
      { $set: { name, phone } }
    );

    // Step 4: Get fresh user data and update Redis cache
    const updatedUser = await users.findOne({ sessionKey });
    const updatedUserPayload = {
      name: updatedUser.name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      userid: updatedUser.userid,
      createdAt: updatedUser.createdAt,
      resetTokenUsed: updatedUser.resetTokenUsed || false,
      resetTokenTime: updatedUser.resetTokenTime || null,
    };

    // Update Redis with fresh data (same session key, reset TTL)
    await redisClient.set(sessionKey, JSON.stringify(updatedUserPayload), {
      EX: 60 * 60 * 24 * 90, // 3 months
    });

    res.json({
      message: 'Profile updated successfully',
      success: true,
      user: updatedUserPayload
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

async function startServer() {
  await connectToMongoDB();
  await ensureUniqueIndexes();
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
}

process.on('SIGINT', async () => {
  console.log('Closing MongoDB connection...');
  await client.close();
  console.log('MongoDB connection closed.');
  process.exit(0);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
