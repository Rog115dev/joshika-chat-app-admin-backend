const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: '' },
    nickname: { type: String, default: '' },
    profileImageUrl: { type: String, default: '' },
    lifeStatus: { type: String, default: 'student' },
    age: { type: Number, default: 0 },
    placeOfLiving: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    interests: { type: [String], default: [] },
    bio: { type: String, default: '' },
    verificationStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'approved', 'rejected'],
    },
    verificationId: { type: Number, default: null },
    similarAgeOn: { type: Boolean, default: undefined },
    nearbyOn: { type: Boolean, default: undefined },
    jpToEnOn: { type: Boolean, default: undefined },
    enToJpOn: { type: Boolean, default: undefined },
    passedUserIds: { type: [Number], default: [] },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { versionKey: false },
);

const verificationSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    userId: { type: Number, default: null, index: true },
    phoneNumber: { type: String, default: '' },
    selfieUrl: { type: String, default: '' },
    status: { type: String, default: 'pending' },
    submittedAt: { type: String, default: () => new Date().toISOString() },
    adminNote: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, index: true },
    name: { type: String, default: '' },
    nickname: { type: String, default: '' },
    profileImageUrl: { type: String, default: '' },
    lifeStatus: { type: String, default: '' },
    age: { type: Number, default: 0 },
    placeOfLiving: { type: String, default: '' },
    interests: { type: [String], default: [] },
  },
  { versionKey: false },
);

const invitationSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    fromUserId: { type: Number, required: true, index: true },
    toUserId: { type: Number, required: true, index: true },
    tableId: { type: Number, default: null },
    tableName: { type: String, default: '' },
    tableImageKey: { type: String, default: '' },
    message: { type: String, default: '' },
    prompts: { type: [String], default: [] },
    status: { type: String, default: 'pending' },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { versionKey: false },
);

const tableSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    tableImageKey: { type: String, default: '' },
    hostUserId: { type: Number, required: true, index: true },
    guestUserId: { type: Number, required: true, index: true },
    invitationId: { type: Number, default: null },
    status: { type: String, default: 'pending' },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { versionKey: false },
);

const messageSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    tableId: { type: Number, required: true, index: true },
    senderId: { type: Number, required: true },
    text: { type: String, required: true },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { versionKey: false },
);

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

const User = mongoose.model('User', userSchema);
const Verification = mongoose.model('Verification', verificationSchema);
const Invitation = mongoose.model('Invitation', invitationSchema);
const Table = mongoose.model('Table', tableSchema);
const Message = mongoose.model('Message', messageSchema);
const Counter = mongoose.model('Counter', counterSchema);

module.exports = {
  User,
  Verification,
  Invitation,
  Table,
  Message,
  Counter,
};
