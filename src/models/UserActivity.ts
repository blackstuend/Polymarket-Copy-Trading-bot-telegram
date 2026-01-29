import mongoose, { Schema, Document } from 'mongoose';

export interface IUserActivity extends Document {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  bot: boolean;
  botExcutedTime: number;
  taskId: string;
  myBoughtSize?: number;
}

const UserActivitySchema: Schema = new Schema({
  proxyWallet: { type: String, required: true, index: true },
  timestamp: { type: Number, required: true },
  conditionId: { type: String },
  type: { type: String },
  size: { type: Number },
  usdcSize: { type: Number },
  transactionHash: { type: String, required: true, unique: true },
  price: { type: Number },
  asset: { type: String },
  side: { type: String },
  outcomeIndex: { type: Number },
  title: { type: String },
  slug: { type: String },
  icon: { type: String },
  eventSlug: { type: String },
  outcome: { type: String },
  name: { type: String },
  pseudonym: { type: String },
  bio: { type: String },
  profileImage: { type: String },
  profileImageOptimized: { type: String },
  bot: { type: Boolean, default: false },
  botExcutedTime: { type: Number, default: 0 },
  taskId: { type: String, index: true },
  myBoughtSize: { type: Number },
});

export const UserActivity = mongoose.model<IUserActivity>('UserActivity', UserActivitySchema);
