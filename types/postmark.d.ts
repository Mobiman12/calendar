declare module "postmark" {
  export class ServerClient {
    constructor(token: string);
    sendEmail(payload: any): Promise<any>;
  }
}
