import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { userId: 'staff1', phone: '13800000001', roleId: 'role1', scope: 'tenant' },
  'pms-hotel-secret-key-2024',
  { expiresIn: '1h' }
);
console.log(token);
