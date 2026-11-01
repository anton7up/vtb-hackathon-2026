// Only salted PBKDF2 hashes are stored. Plaintext demo passwords are handed to the owner separately.
export const ACCOUNT_SEEDS = [
  { id: 'account-client', login: 'client', role: 'client', name: 'Анна Ковалёва', clientId: 'client-demo', salt: '8611d8a808b80227574c578dda3e7ba6', hash: '93f4196fd66fb162860258cb8041169d8ff390bc7494c515b5465c48f19b5eb2' },
  { id: 'account-employee', login: 'employee', role: 'employee', name: 'Сотрудник антифрода', clientId: null, salt: 'c64df5f25cda8dc75bdc2be61e4f2562', hash: '22e463892d41e654ca3c38c7770947a5fcf401d1b86dea7c81fa0e697bb645ad' },
  { id: 'account-client-two', login: 'client2', role: 'client', name: 'Дмитрий Соколов', clientId: 'client-demo-2', salt: '4e992f9ca88100f235ef8d0063f8a1a9', hash: '9c006122b62fbbb619f9bef5cd70a275ed34e60f1760acc12196000ac1c3d0b3' },
  { id: 'account-client-three', login: 'client3', role: 'client', name: 'Елена Соколова', clientId: 'client-demo-3', salt: '2ceba77769a8bb1732cde3329012407f', hash: 'f09594423bce4c405cf780b765253e7ba91807f63c545019637a014f4d98aa2f' }
];
