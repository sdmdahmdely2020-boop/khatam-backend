const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Khatam backend en écoute sur http://localhost:${PORT}`);
});
