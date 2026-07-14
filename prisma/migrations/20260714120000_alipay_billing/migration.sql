-- CreateEnum
CREATE TYPE "UserSuspensionReason" AS ENUM ('NONE', 'MANUAL', 'ADMIN', 'SUBSCRIPTION_EXPIRED');

-- CreateEnum
CREATE TYPE "BillingOrderStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLED', 'FAILED', 'CLOSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BillingOrderSource" AS ENUM ('SELF_SERVICE', 'MANUAL_ADMIN');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "GlobalOptions"
ADD COLUMN "alipayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "alipayAppId" TEXT,
ADD COLUMN "alipaySellerId" TEXT,
ADD COLUMN "alipayGateway" TEXT NOT NULL DEFAULT 'https://openapi.alipay.com/gateway.do',
ADD COLUMN "alipayPrivateKeyEncrypted" TEXT,
ADD COLUMN "alipayPublicKey" TEXT;

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "suspensionReason" "UserSuspensionReason" NOT NULL DEFAULT 'NONE',
ADD COLUMN "legacyBillingExempt" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the pre-billing behavior only for existing accounts that had no group.
UPDATE "User" SET "legacyBillingExempt" = true WHERE "userGroupId" IS NULL;

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "userGroupId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOrder" (
    "id" TEXT NOT NULL,
    "merchantOrderNo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "status" "BillingOrderStatus" NOT NULL DEFAULT 'PENDING',
    "source" "BillingOrderSource" NOT NULL DEFAULT 'SELF_SERVICE',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "subject" TEXT NOT NULL,
    "planNameSnapshot" TEXT NOT NULL,
    "planPriceCentsSnapshot" INTEGER NOT NULL,
    "durationMonthsSnapshot" INTEGER NOT NULL,
    "planLevelSnapshot" INTEGER NOT NULL,
    "maxNetworksSnapshot" INTEGER NOT NULL,
    "userGroupIdSnapshot" INTEGER NOT NULL,
    "baseAmountCentsSnapshot" INTEGER NOT NULL,
    "upgradeAmountCentsSnapshot" INTEGER NOT NULL DEFAULT 0,
    "adminNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "entitlementAppliedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "alipayTradeNo" TEXT NOT NULL,
    "buyerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "tradeStatus" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "orderId" TEXT,
    "eventType" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxNetworksSnapshot" INTEGER NOT NULL,
    "userGroupIdSnapshot" INTEGER NOT NULL,
    "planPriceCentsSnapshot" INTEGER NOT NULL,
    "durationMonthsSnapshot" INTEGER NOT NULL,
    "planLevelSnapshot" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionSuspensionSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "networkId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "wasAuthorized" BOOLEAN NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionSuspensionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkQuotaReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkQuotaReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlan_name_key" ON "BillingPlan"("name");

-- CreateIndex
CREATE INDEX "BillingPlan_userGroupId_idx" ON "BillingPlan"("userGroupId");

-- CreateIndex
CREATE INDEX "BillingPlan_isActive_sortOrder_level_idx" ON "BillingPlan"("isActive", "sortOrder", "level");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOrder_merchantOrderNo_key" ON "BillingOrder"("merchantOrderNo");

-- CreateIndex
CREATE INDEX "BillingOrder_userId_createdAt_idx" ON "BillingOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingOrder_planId_idx" ON "BillingOrder"("planId");

-- CreateIndex
CREATE INDEX "BillingOrder_status_expiresAt_idx" ON "BillingOrder"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BillingOrder_source_createdAt_idx" ON "BillingOrder"("source", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_orderId_key" ON "PaymentTransaction"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_alipayTradeNo_key" ON "PaymentTransaction"("alipayTradeNo");

-- CreateIndex
CREATE INDEX "PaymentTransaction_tradeStatus_paidAt_idx" ON "PaymentTransaction"("tradeStatus", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_eventHash_key" ON "PaymentEvent"("eventHash");

-- CreateIndex
CREATE INDEX "PaymentEvent_orderId_idx" ON "PaymentEvent"("orderId");

-- CreateIndex
CREATE INDEX "PaymentEvent_processedAt_createdAt_idx" ON "PaymentEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE INDEX "Subscription_status_expiresAt_idx" ON "Subscription"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionSuspensionSnapshot_userId_networkId_memberId_key" ON "SubscriptionSuspensionSnapshot"("userId", "networkId", "memberId");

-- CreateIndex
CREATE INDEX "SubscriptionSuspensionSnapshot_subscriptionId_idx" ON "SubscriptionSuspensionSnapshot"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionSuspensionSnapshot_networkId_idx" ON "SubscriptionSuspensionSnapshot"("networkId");

-- CreateIndex
CREATE INDEX "SubscriptionSuspensionSnapshot_userId_restoredAt_idx" ON "SubscriptionSuspensionSnapshot"("userId", "restoredAt");

-- CreateIndex
CREATE INDEX "NetworkQuotaReservation_userId_expiresAt_idx" ON "NetworkQuotaReservation"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "NetworkQuotaReservation_expiresAt_idx" ON "NetworkQuotaReservation"("expiresAt");

-- AddForeignKey
ALTER TABLE "BillingPlan" ADD CONSTRAINT "BillingPlan_userGroupId_fkey" FOREIGN KEY ("userGroupId") REFERENCES "UserGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionSuspensionSnapshot" ADD CONSTRAINT "SubscriptionSuspensionSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionSuspensionSnapshot" ADD CONSTRAINT "SubscriptionSuspensionSnapshot_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionSuspensionSnapshot" ADD CONSTRAINT "SubscriptionSuspensionSnapshot_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "network"("nwid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkQuotaReservation" ADD CONSTRAINT "NetworkQuotaReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
