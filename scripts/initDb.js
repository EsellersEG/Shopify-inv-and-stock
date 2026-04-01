import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

async function setup() {
  const password = 'E-sellers.net';
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const initialData = {
    users: [
      {
        id: 'admin-1',
        email: 'yahia@e-sellers.net',
        password: hashedPassword,
        role: 'admin',
        name: 'Yahia'
      }
    ],
    clients: [
      {
        id: 'client-mira',
        userId: 'admin-1', // Link to a user if needed, or just a separate entity
        name: 'Mira Medical',
        stores: []
      }
    ]
  };

  if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
  }

  fs.writeFileSync('./data/db.json', JSON.stringify(initialData, null, 2));
  console.log('Database initialized with admin user.');
}

setup();
