export const api = {
  get: async (url: string) => {
    const token = localStorage.getItem('token');
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return res.json();
  },
  post: async (url: string, data: any) => {
    const token = localStorage.getItem('token');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return res.json();
  }
};
