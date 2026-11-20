import mongoose, { Document, Schema } from 'mongoose';

export interface ICommunityMembership extends Document {
  groupId: mongoose.Types.ObjectId;
  userId: string;
  createdAt: Date;
}

const CommunityMembershipSchema = new Schema<ICommunityMembership>(
  {
    groupId: {
      type: Schema.Types.ObjectId,
      ref: 'CommunityGroup',
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CommunityMembershipSchema.index({ groupId: 1, userId: 1 }, { unique: true });

export const CommunityMembership = mongoose.model<ICommunityMembership>(
  'CommunityMembership',
  CommunityMembershipSchema
);
