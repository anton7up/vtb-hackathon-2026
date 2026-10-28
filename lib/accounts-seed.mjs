// Only salted PBKDF2 hashes are stored. Plaintext demo passwords are handed to the owner separately.
export const ACCOUNT_SEEDS = [
  { id: 'account-client', login: 'client', role: 'client', name: 'Анна Ковалёва', clientId: 'client-demo', salt: '8611d8a808b80227574c578dda3e7ba6', hash: '93f4196fd66fb162860258cb8041169d8ff390bc7494c515b5465c48f19b5eb2' },
  { id: 'account-employee', login: 'employee', role: 'employee', name: 'Сотрудник антифрода', clientId: null, salt: 'c64df5f25cda8dc75bdc2be61e4f2562', hash: '22e463892d41e654ca3c38c7770947a5fcf401d1b86dea7c81fa0e697bb645ad' }
];
