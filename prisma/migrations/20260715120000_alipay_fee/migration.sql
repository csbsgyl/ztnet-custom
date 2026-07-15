-- AlterTable
ALTER TABLE "GlobalOptions"
ADD COLUMN "alipayFeeRateBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BillingOrder"
ADD COLUMN "feeRateBpsSnapshot" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "feeAmountCentsSnapshot" INTEGER NOT NULL DEFAULT 0;
