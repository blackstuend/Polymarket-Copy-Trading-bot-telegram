import mongoose, { Schema, Document } from 'mongoose';

export interface IUserPosition extends Document {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
  taskId: string;
}

const UserPositionSchema: Schema = new Schema({
  proxyWallet: { type: String, required: true, index: true },
  asset: { type: String, required: true },
  conditionId: { type: String, required: true },
  size: { type: Number },
  avgPrice: { type: Number },
  initialValue: { type: Number },
  currentValue: { type: Number },
  cashPnl: { type: Number },
  percentPnl: { type: Number },
  totalBought: { type: Number },
  realizedPnl: { type: Number },
  percentRealizedPnl: { type: Number },
  curPrice: { type: Number },
  redeemable: { type: Boolean, default: false },
  mergeable: { type: Boolean, default: false },
  title: { type: String },
  slug: { type: String },
  icon: { type: String },
  eventSlug: { type: String },
  outcome: { type: String },
  outcomeIndex: { type: Number },
  oppositeOutcome: { type: String },
  oppositeAsset: { type: String },
  endDate: { type: String },
  negativeRisk: { type: Boolean, default: false },
  taskId: { type: String, required: true, index: true },
});

// Ensure uniqueness per user per asset per task
UserPositionSchema.index({ proxyWallet: 1, asset: 1, conditionId: 1, taskId: 1 }, { unique: true });

export const UserPosition = mongoose.model<IUserPosition>('UserPosition', UserPositionSchema);
