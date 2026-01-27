import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { UserPosition } from '../models/UserPosition.js';

export async function connectToMongoDB(): Promise<void> {
  try {
    await mongoose.connect(config.mongodb.uri);

    // Keep collection indexes aligned with schema to avoid stale unique constraints.
    await UserPosition.syncIndexes();
    
    mongoose.connection.on('error', (error) => {
      console.error('❌ MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected');
    });

  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error);
    throw error;
  }
}

export async function closeMongoDBConnection(): Promise<void> {
  try {
    await mongoose.connection.close();
    console.log('📦 MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
  }
}
