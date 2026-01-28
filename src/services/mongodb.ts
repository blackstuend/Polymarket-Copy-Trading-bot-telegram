import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { UserPosition } from '../models/UserPosition.js';
import { logger } from '../utils/logger.js';

export async function connectToMongoDB(): Promise<void> {
  try {
    await mongoose.connect(config.mongodb.uri);

    // Keep collection indexes aligned with schema to avoid stale unique constraints.
    await UserPosition.syncIndexes();
    
    mongoose.connection.on('error', (error) => {
      logger.error({ err: error }, '❌ MongoDB connection error');
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
    });

  } catch (error) {
    logger.error({ err: error }, '❌ Error connecting to MongoDB');
    throw error;
  }
}

export async function closeMongoDBConnection(): Promise<void> {
  try {
    await mongoose.connection.close();
    logger.info('📦 MongoDB connection closed');
  } catch (error) {
    logger.error({ err: error }, '❌ Error closing MongoDB connection');
  }
}
