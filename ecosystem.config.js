module.exports = {
  apps: [
    {
      name: "solar360careapi",
      script: "./server.js",
      cwd: "/var/www/vitsolutions24x7/solar360careapi",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",

        PORT: 5004,
        APP_URL: "https://vitsolutions24x7.com",

        // DB CONFIG
        DB_HOST: "localhost",
        DB_PORT: 3306,
        DB_NAME: "solar360crm",
        DB_USER: "admin",
        DB_PASSWORD: "Poonam#@#1988",

        // AUTH
        JWT_SECRET: "mysecretkey",
        JWT_EXPIRATION: "1h",
        SESSION_SECRET: "sesssecret",

        // WHATSAPP CONFIG
        WHATSAPP_TOKEN: "EAANDnRBocToBRPXV66ub3qsTBZCc070I6ZAc7icgGaZBtA4Gr9Cg7c29EUlJScVrYfj4b5jYNRNIvfQD078lrM3ZADqMtIRBHSxLbDCxYDUMQIFSsvaZALltCiX7VzXsfYjw3NWra4I8CEkZBzg26OwFHv6ZBHerjkFefZBKZC60KdA1HtrKo8qv0hI7QE3ZAHRfgfjQZDZD",
        WHATSAPP_PHONE_ID: "1032810579919606",
        VERIFY_TOKEN: "my_verify_token",
        WABA_ID: "796505140178697",

        // META CONFIG
        META_APP_ID: "918766794338618",
        META_APP_SECRET: "5ecec2b05fb94f3f17c7647efa948226",
        META_REDIRECT_URI: "http://localhost:5000/api/auth/facebook/callback",

        // FRONTEND
        FRONTEND_META_CALLBACK_URL: "http://localhost:3000/settings/whatsapp/callback",
        FRONTEND_URL: "http://localhost:3000",

        // API VERSION
        FB_API_VERSION: "v25.0"
      }
    }
  ]
};