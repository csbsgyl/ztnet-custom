import os from "node:os";

export const ZT_FOLDER =
	os.platform() === "freebsd" ? "/var/db/zerotier-one" : "/var/lib/zerotier-one";

export const ZT_FILE = process.env.ZT_SECRET_FILE || `${ZT_FOLDER}/authtoken.secret`;
