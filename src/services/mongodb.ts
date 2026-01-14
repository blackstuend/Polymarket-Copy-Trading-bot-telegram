import mongoose from 'mongoose';
import { config } from '../config/index.js';

export async function connectToMongoDB(): Promise<void> {
  try {
    const uri = config.mongodb.uri as string;
    
    await mongoose.connect(uri);
    
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
