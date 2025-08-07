require('dotenv').config();
const { createClient } = require('redis');

const redisClient = createClient({
  url: process.env.REACT_APP_REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.log('Max reconnection attempts reached');
        return false; 
      }
      return Math.min(retries * 1000, 5000); 
    },
  }
});

let isConnecting = false;
let isConnected = false;

async function connectRedis() {
  if (isConnecting || isConnected) return;
  
  isConnecting = true;
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      isConnected = true;
      console.log('Connected to Cloud Redis!');
    }
  } catch (error) {
    console.error('Failed to connect to Redis:', error.message);
    setTimeout(connectRedis, 5000);
  } finally {
    isConnecting = false;
  }
}

connectRedis();

redisClient.on('ready', () => {
  isConnected = true;
  console.log('Redis client ready');
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err.message);
  isConnected = false;
  
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
    console.log('Attempting to reconnect to Redis...');
    if (!isConnecting) {
      setTimeout(connectRedis, 5000);
    }
  }
});

redisClient.on('end', () => {
  isConnected = false;
  console.log('Redis connection closed');
  if (!isConnecting) {
    setTimeout(connectRedis, 5000);
  }
});

process.on('SIGINT', async () => {
  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
      console.log('Redis client disconnected gracefully');
    }
    process.exit(0);
  } catch (err) {
    console.error('Error disconnecting Redis:', err);
    process.exit(1);
  }
});

module.exports = redisClient;
