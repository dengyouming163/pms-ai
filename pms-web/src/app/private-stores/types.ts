// 私域门店相关类型定义

export interface ApplicationData {
  status?: 'draft' | 'pending' | 'finished' | 'rejected' | 'wx_rejected';
  subMchid?: string;
  rejectReason?: string;
  businessLicense?: {
    number: string;
    name: string;
    imageUrl: string;
  };
  legalPerson?: {
    name: string;
    idNumber: string;
    idFrontUrl: string;
    idBackUrl: string;
  };
  settlementAccount?: {
    accountName: string;
    accountNumber: string;
    bankName: string;
  };
  contact?: {
    name: string;
    phone: string;
  };
  [key: string]: any;
}

export interface PackageData {
  id: string;
  name: string;
  price: number;
  stock: number;
  description: string;
  roomTypeIds: string[];
  benefits: string[];
  images: string[];
  active: boolean;
  createdAt: string;
  [key: string]: any;
}

export interface CouponData {
  id: string;
  name: string;
  type: 'full_reduce' | 'discount' | 'newcomer';
  value: number;
  minAmount: number;
  perUser: number;
  validDays: number;
  total: number;
  active: boolean;
  createdAt: string;
  [key: string]: any;
}

export interface PromoterData {
  id: string;
  name: string;
  phone: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  [key: string]: any;
}

export interface StoreConfig {
  headerImages: string[];
  intro: string;
  gallery: string[];
  cancelPolicy: {
    freeHours: number;
    feeRate: number;
  };
  online: boolean;
  memberDiscounts: Record<string, number>;
  [key: string]: any;
}
