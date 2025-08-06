const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));


const PORT = process.env.REACT_APP_PORT || 10000;
// const MONGODB_URI = 'mongodb://localhost:27017'; // Use local MongoDB
 const MONGODB_URI = process.env.REACT_APP_MONGO_URL;

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
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      name,
      email,
      phone,
      password: hashedPassword,
      createdAt: new Date()
    };

    const result = await db.collection('Consumers').insertOne(newUser);
    res.status(201).json({ success: true, message: 'Registration successful', userId: result.insertedId });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


app.post('/login', async (req, res) => {
//   console.log('Received Login:', req.body); // add this

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' });
  }

  const user = await db.collection('Consumers').findOne({ email });
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  return res.status(200).json({ message: 'Login successful' });
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
