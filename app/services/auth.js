const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Config = require('../config');
const CustomError = require('./custom-error');
const User = require('../models/user');


class AuthService {
	static signup(email, passphrase) {
		return User.findByEmail(email)
		.then((user) => {
			if (user) {
				throw new CustomError.UserExists(email);
			}

			const secret = Config['jwtSecret'];
			const encrypted_passphrase =
				crypto.createHmac('sha1', secret)
				.update(passphrase)
				.digest('base64');

			return User.create(email, encrypted_passphrase)
			.then((user) => user.toObject());
		});
	}

	static login(email, passphrase) {
		return User.findByEmail(email)
		.then((user) => {
			if (!user) {
				throw new CustomError.UserNotFound(email);
			}
			user = user.toObject();

			const secret = Config['jwtSecret'];
			const encrypted_passphrase =
				crypto.createHmac('sha1', secret)
				.update(passphrase)
				.digest('base64');
			if (user.passphrase !== encrypted_passphrase) {
				throw new CustomError.AuthenticationFailed('Passphrase is wrong.');
			}

			// Generate and respond the token if sign in succeeded.
			const payload = {
				email: user.email,
				admin: user.admin
			};
			const options = {
				expiresIn: '1d',
				issuer: 'thecommerce.co.kr'
			};
			return new Promise((resolve, reject) => {
				jwt.sign(payload, secret, options, (err, token) => {
					if (err) reject(err);
					else resolve(token);
				});
			});
		});
	}

	static verify(token) {
		if (!token) {
			throw new CustomError.AuthenticationFailed('Token is not specified. Not logged in.');
		}

		return new Promise((resolve, reject) => {
			const secret = Config['jwtSecret'];
			jwt.verify(token, secret, (err, payload) => {
				if (err) reject(err);
				else resolve(payload);
			});
		});
	}


	// FOR TEST
	static test() {
		const email = 'mankiplayer@hotmail.com';
		const pass = 'aksrldi09a';

		return User.initialize()
		.then(() => AuthService.signup(email, pass))
		.then(() => AuthService.login(email, pass))
		.then((token) => {
			console.log('* Issued token:');
			console.log(token);
			return AuthService.verify(token);
		})
		.then((payload) => {
			console.log('* Restored payload:');
			console.log(payload);

			return User.remove(email);
		})
		.then(() => {
			console.log('PASSED.');
		})
		.catch((err) => {
			console.error(err);
		});
	}
}


module.exports = AuthService;
