const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const AWS = require('aws-sdk'); 

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));

const PORT = process.env.REACT_APP_PORT || 10000;
const MONGODB_URI = process.env.REACT_APP_MONGO_URL;
const redisClient = require('./redisClient');

const s3 = new AWS.S3({
  region: process.env.REACT_APP_AWS_REGION || 'us-east-1',
  accessKeyId: process.env.REACT_APP_AWS_KEY,
  secretAccessKey: process.env.REACT_APP_AWS_SECRET,
  signatureVersion: 'v4'
});
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});


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
app.post('/imageupload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    const { userid, description } = req.body;
    if (!userid) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    // Generate filename
    const randomDigits = Math.floor(100000 + Math.random() * 900000);
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const fileExtension = path.extname(req.file.originalname) || '.jpg';
    const fileName = `reports/${userid}_image${randomDigits}_${timestamp}${fileExtension}`;

    // Authorize B2 and upload
    const uploadParams = {
      Bucket: 'myclimate789',
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    const uploadResult = await s3.upload(uploadParams).promise();
    console.log('S3 upload successful:', uploadResult.Location);

    const imageUrl = uploadResult.Location;

    const reportsCollection = db.collection('reports');
    const existingReport = await reportsCollection.findOne({ imageurl: imageUrl });
    
    if (existingReport) {
      try {
        await s3.deleteObject({
          Bucket: 'myclimate789',
          Key: fileName
        }).promise();
        console.log('Duplicate file removed from S3:', fileName);
      } catch (deleteError) {
        console.error('Error removing duplicate file from S3:', deleteError);
      }
      
      return res.status(409).json({
        success: false,
        error: 'Duplicate image URL detected. This image has already been uploaded.',
        existingReport: {
          reportId: existingReport._id,
          uploadedAt: existingReport.raisedat
        }
      });
    }

    // Save to MongoDB only if no duplicate found
    const reportData = {
      userid: userid,
      description: description || '',
      imageurl: imageUrl,
      raisedat: new Date(),
      filename: fileName,
      filesize: req.file.size,
      mimetype: req.file.mimetype,
      s3Key: fileName
    };

    const mongoResult = await reportsCollection.insertOne(reportData);

    // Simple success response
    res.status(200).json({
      success: true,
      message: 'Climate report uploaded successfully',
      data: {
        reportId: mongoResult.insertedId,
        imageUrl: imageUrl,
        userid: userid,
        description: description || '',
        uploadedAt: reportData.raisedat
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      details: error.message
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 10MB'
      });
    }
  }
  if (error.message === 'Only image files are allowed!') {
    return res.status(400).json({
      success: false,
      error: 'Only image files are allowed'
    });
  }
  
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
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
      userid:user.userid,
      name:user.name,
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

app.post('/password/change', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        message: 'Current password and new password are required.' 
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ 
        message: 'New password must be at least 8 characters long.' 
      });
    }
 const userId = req.user?.userid || req.body.userid; 
    if (!userId) {
      return res.status(401).json({ message: 'User ID required. Please login again.' });
    }
    const users = db.collection('Consumers');
    const user = await users.findOne({ userid: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }
    const saltRounds = 12;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    const updateResult = await users.updateOne(
      { userid: userId },
      { 
        $set: { 
          password: hashedNewPassword,
          passwordChangedAt: new Date()
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(500).json({ message: 'Failed to update password.' });
    }

    // Success response
    res.status(200).json({ 
      message: 'Password changed successfully!',
      success: true 
    });
    } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ 
      message: 'Internal server error. Please try again later.' 
    });
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

