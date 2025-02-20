import fs from "fs";
import chalk from "chalk";

// @ts-ignore
import sb from "satoshi-bitcoin";

import { Operation } from "../models/operation";
import { configuration } from "../configuration/settings";

/**
 * Get contents from file to import
 * @param  {string} path
 *          Path of file to import
 * @returns string
 *          Imported contents
 */
const getFileContents = (path: string) : string => {
    if (!fs.existsSync(path)) {
        throw new Error("Imported file " + path + " does not exist");
    }

    try {
        const contents = fs.readFileSync(path, "utf-8");
        return contents;
    }
    catch (err) {
        console.log(chalk.red("File error"));
        throw new Error(err);
    }
};

/**
 * Import transactions from a type A CSV
 * @param  {string} contents
 *          Contents from file to import
 * @returns Operation
 *          Imported operations
 */
const importFromCSVTypeA = (contents: string) : Operation[] => {
    const operations: Operation[] = [];
    
    contents.split(/\r?\n/).slice(1).forEach(line => {
        // split using delimiter ',' except when between double quotes
        // as a type A CSV can have several addresses in the same field:
        // ...,'<address1>,<address2>,<address3',...
        const tokens = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        
        if (tokens.length < 20) {
            return;
        }

        // expected date format: yyyy-MM-dd HH:mm:ss
        const date =        /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/ig
                            .exec(tokens[0]) || "";

        const type =        String(tokens[2]);      // CREDIT || DEBIT
        const status =      String(tokens[4]);      // CONFIRMED || ABORTED
        const amount =      parseFloat(tokens[8]);  // in bitcoins
        const txid =        tokens[16];
        const sender =      String(tokens[17]).replace("\"", "");
        const recipient =   String(tokens[18]).replace("\"", "");

        // process only confirmed transactions
        if (status === "CONFIRMED") {
            if (type === "CREDIT") {
                const op = new Operation(date[0], amount);
                op.setTxid(txid);

                // recipient: one address or several concatenated addresses
                // ! for this type of CSV, this field is required and should 
                // default to a non-empty string (here: `(no address)`) to 
                // ensure that an operation without address results in a mismatch
                op.setAddress(recipient); 
                                                            
                op.setType("Received");

                operations.push(op);
            }
            else if (type === "DEBIT") {
                const op = new Operation(date[0], amount);
                op.setTxid(txid);

                // sender: one address or several concatenated addresses
                // ! for this type of CSV, this field is required and should 
                // default to a non-empty string (here: `(no address)`) to 
                // ensure that an operation without address results in a mismatch
                op.setAddress(sender);

                op.setType("Sent");

                operations.push(op);
            }
        }
    });

    return operations;
};

/**
 * Import transactions from a type B CSV
 * @param  {string} contents
 *          Contents from file to import
 * @returns Operation
 *          Imported operations
 */
const importFromCSVTypeB = (contents: string) : Operation[] => {
    const operations: Operation[] = [];
    
    contents.split(/\r?\n/).slice(1).forEach( (line: string) => {
        const tokens = line.split(/,/);

        if (tokens.length < 8) {
            return;
        }

        // expected date format: yyyy-MM-dd HH:mm:ss
        const date =        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/ig
                            .exec(tokens[0]) || "";

        const type =        String(tokens[2]);      // IN | OUT
        const amount =      parseFloat(tokens[3]);  // in bitcoins
        const fees =        parseFloat(tokens[4]);  // in bitcoins
        const txid =        tokens[5];

        // note: type B CSV does not refer to addresses
        if (type === "IN") {
            const op = new Operation(date[0], amount);
            op.setTxid(txid);
            op.setType("Received");

            operations.push(op);
        }
        else if (type === "OUT") {
            // out transactions: substract fees from amount (in satoshis)...
            const amountInSatoshis = sb.toSatoshi(amount) - sb.toSatoshi(fees);
            // ... and convert the total back to Bitcoin
            // (otherwise, there would be floating number issues)
            const op = new Operation(date[0], sb.toBitcoin(amountInSatoshis));
            op.setTxid(txid);
            op.setType("Sent");

            operations.push(op);
        }
    });

    return operations;
};

/**
 * Import transactions from a type A JSON
 * @param  {string} contents
 *          Contents from file to import
 * @returns Operation
 *          Imported operations
 */
const importFromJSONTypeA = (contents: string) : Operation[] => {    
    const operations: Operation[] = [];

    let ops;

    try {
        ops = JSON.parse(contents).operations;
    } 
    catch (err) {
        throw new Error("JSON parsing error");
    }

    for (const operation of ops) {
        const type              = operation.operation_type;
        
        const date              = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/ig
                                    .exec(operation.transaction.received_at) || "";

        const txid              = operation.hash;
        const valueInSatoshis   = parseFloat(operation.amount);      // in satoshis
        const feesInSatoshis    = parseFloat(operation.fees);        // in satoshis

        if (type === "receive") {
            const op = new Operation(date[0], sb.toBitcoin(valueInSatoshis));
            op.setTxid(txid);
            op.setType("Received");
            
            const addresses = [];
            for (const output of operation.transaction.outputs) {
                if (output.derivation !== null) {
                    addresses.push(output.address);
                }
            }

            op.setAddress(addresses.join(","));

            operations.push(op);
        }
        else if (type === "send") {
            // out transactions: substract fees from amount (in satoshis)...
            const amountInSatoshis = valueInSatoshis - feesInSatoshis;
            // ... and convert the total back to Bitcoin
            // (otherwise, there would be floating number issues)
            const op = new Operation(date[0], sb.toBitcoin(amountInSatoshis));
            op.setTxid(txid);
            op.setType("Sent");

            const addresses = [];
            for (const input of operation.transaction.inputs) {
                if (input.derivation !== null) {
                        addresses.push(input.address);
                }
            }

            op.setAddress(addresses.join(","));

            operations.push(op);
        }
    }

    return operations;
};

/**
 * Import transactions from a type B JSON
 * @param  {string} contents
 *          Contents from file to import
 * @returns Operation
 *          Imported operations
 */
const importFromJSONTypeB = (contents: string) : Operation[] => {
    const operations: Operation[] = [];

    let ops;

    try {
        ops = JSON.parse(contents).operations;
    } 
    catch (err) {
        throw new Error("JSON parsing error");
    }

    for (const operation of ops) {
        const type              = operation.type;
        
        const date              = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/ig
                                    .exec(operation.date) || "";

        const txid              = operation.hash;
        const valueInSatoshis   = parseFloat(operation.value);      // in satoshis
        const feesInSatoshis    = parseFloat(operation.fee);        // in satoshis
        const recipient         = operation.recipients.join(",");
        const sender            = operation.senders.join(",");

        if (type === "IN") {
            const op = new Operation(date[0], sb.toBitcoin(valueInSatoshis));
            op.setTxid(txid);
            op.setType("Received");
            op.setAddress(recipient);

            operations.push(op);
        }
        else if (type === "OUT") {
            // out transactions: substract fees from amount (in satoshis)...
            const amountInSatoshis = valueInSatoshis - feesInSatoshis;
            // ... and convert the total back to Bitcoin
            // (otherwise, there would be floating number issues)
            const op = new Operation(date[0], sb.toBitcoin(amountInSatoshis));
            op.setTxid(txid);
            op.setType("Sent");
            op.setAddress(sender);

            operations.push(op);
        }

    }

    return operations;
};

/**
 * Import transactions from a type C JSON
 * @param  {string} contents
 *          Contents from file to import
 * @returns Operation
 *          Imported operations
 */
 const importFromJSONTypeC = (contents: string) : Operation[] => {    
    const operations: Operation[] = [];

    let ops;

    try {
        ops = JSON.parse(contents).operations;
    } 
    catch (err) {
        throw new Error("JSON parsing error");
    }

    for (const operation of ops) {
        const type              = operation.type;
        
        const date              = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/ig
                                    .exec(operation.time) || "";

        const valueInSatoshis   = parseFloat(operation.amount);      // in satoshis
        
        const txid              = operation.transaction.hash;
        
        if (type === "RECEIVE") {
            const op = new Operation(date[0], sb.toBitcoin(valueInSatoshis));
            op.setType("Received");

            op.setTxid(txid);
            
            const addresses = [];
            for (const output of operation.recipients) {
                addresses.push(output);
            }

            op.setAddress(addresses.join(","));

            operations.push(op);
        }
        else if (type === "SEND") {
            const op = new Operation(date[0], sb.toBitcoin(valueInSatoshis));

            op.setType("Sent");

            op.setTxid(txid);

            const addresses = [];
            for (const input of operation.senders) {
                addresses.push(input);
            }

            op.setAddress(addresses.join(","));

            operations.push(op);
        }
    }

    return operations;
};

/**
 * Dispatcher: detect the type of the imported file
 * based on its contents
 * @param  {string} path
 *          Path of file to import
 * @returns Operation
 *          Imported transactions
 */
const importOperations = (path: string) : Operation[] => {
    const contents = getFileContents(path);
    const firstLine = contents.split(/\r?\n/)[0].replace("\"", "");

    let operations: Operation[] = [];

    // CSV FILES
    if (firstLine.substring(0, 8) === "Creation") {
        // type A CSV: 'Creation' is the first token
        operations = importFromCSVTypeA(contents);
    }
    else if (firstLine.substring(0, 9) === "Operation") {
        // type B CSV: 'Operation' is the first token
        operations = importFromCSVTypeB(contents);
    }

    // JSON FILES
    else if (firstLine.startsWith("{") || firstLine.startsWith("[")) {
        if (contents.includes("cursor")) {
            // type A JSON: contains a reference to 'cursor',
            //              an ambiguous term, but sufficient to 
            //              distinguish it from type B JSON files
            operations = importFromJSONTypeA(contents);
        }
        else if (contents.includes("libcore")) {
            // type B JSON: contains an explicit reference to 'libcore'
            operations = importFromJSONTypeB(contents);
        }
        else if (contents.includes("uid")) {
            // type C JSON: contains an explicit reference to 'uid'
            operations = importFromJSONTypeC(contents);
        }
    }
    else {
        throw new Error("Format not recognized.");
    }

    if (!configuration.silent) {
        console.log(
            chalk.grey(
                String(operations.length)
                .concat(" operations have been imported")
            )
        );
    }

    // TODO: at this point, generate a warning/error 
    // message if no operation has been imported 
    // (file parsing issue?)

    return operations;
};

export { importOperations };