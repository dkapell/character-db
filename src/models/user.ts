'use strict';
import async from 'async';
import _ from 'underscore';
import database from '../lib/database';
import cache from '../lib/cache';
import validator from 'validator';

import campaign_userModel from './campaign_user';
import campaignModel from './campaign';

const models = {
    campaign_user: campaign_userModel,
    campaign: campaignModel
};

const tableFields = ['name', 'email', 'google_id', 'site_admin'];

async function get(campaignId, id){
    if (!id){ throw new Error('no id specified'); }
    let user = await cache.check('user', id);

    if (user) {
        return postSelect(user, campaignId);
    }

    const query = 'select * from users where id = $1';
    const result = await database.query(query, [id]);
    if (result.rows.length){
        user = result.rows[0];
        await cache.store('user', id, user);

        return postSelect(user, campaignId);
    }
    return;
};

async function find (campaignId, conditions = {}, options:RequestOptions = {}){
    const queryParts = [];
    const queryData = [];
    for (const field of tableFields){
        if (_.has(conditions, field)){
            queryParts.push(field + ' = $' + (queryParts.length+1));
            queryData.push(conditions[field]);
        }
    }
    let query = 'select * from users';
    if (queryParts.length){
        query += ' where ' + queryParts.join(' and ');
    }
    query += ' order by name';

    if (_.has(options, 'offset')){
        query += ` offset ${Number(options.offset)}`;
    }

    if (_.has(options, 'limit')){
        query += ` limit ${Number(options.limit)}`;
    }
    const result = await database.query(query, queryData);
    return async.map(result.rows, async(row) => {
        return postSelect(row, campaignId);
    });
};

async function findOne(campaignId, conditions, options:RequestOptions = {}){
    options.limit = 1;
    const results = await find(campaignId, conditions, options);
    if (results.length){
        return results[0];
    }
    return;
};

async function create(campaignId, data){
    if (! validate(data)){
        throw new Error('Invalid Data');
    }
    const queryFields = [];
    const queryData = [];
    const queryValues = [];
    for (const field of tableFields){
        if (_.has(data, field)){
            queryFields.push(field);
            queryValues.push('$' + queryFields.length);
            queryData.push(data[field]);
        }
    }

    let query = 'insert into users (';
    query += queryFields.join (', ');
    query += ') values (';
    query += queryValues.join (', ');
    query += ') returning id';

    const result = await database.query(query, queryData);
    await postSave(result.rows[0].id, data, campaignId);
    return result.rows[0].id;
};


async function update(campaignId, id, data){
    if (! validate(data)){
        throw new Error('Invalid Data');
    }
    const queryUpdates = [];
    const queryData = [id];
    for (const field of tableFields){
        if (_.has(data, field)){
            queryUpdates.push(field + ' = $' + (queryUpdates.length+2));
            queryData.push(data[field]);
        }
    }

    let query = 'update users set ';
    query += queryUpdates.join(', ');
    query += ' where id = $1';
    if (queryData.length > 1){
        await database.query(query, queryData);
        await cache.invalidate('user', id);
    }
    await postSave(id, data, campaignId);
};

async function remove(campaignId, id){
    if (campaignId){
        const campaign_user = await models.campaign_user.findOne({user_id: id, campaign_id: campaignId});
        if (campaign_user){
            await models.campaign_user.delete({user_id: id, campaign_id: campaignId});
        }
        const campaign_users = await models.campaign_user.find({user_id: id});
        if (!campaign_users.length){
            return remove(null, id);
        }
    } else {
        const query = 'delete from users where id = $1';
        await database.query(query, [id]);
        await cache.invalidate('user', id);
    }
};

async function findOrCreate(campaignId, data, noNameUpdate){
    let user = await findOne(campaignId, {google_id: data.google_id});
    if (user) {
        for (const field in data){
            if (field === 'name' && noNameUpdate){
                continue;
            }
            if (_.has(user, field)){
                user[field] = data[field];
            }
        }
        await update(campaignId, user.id, user);
        return await get(campaignId, user.id);

    } else {
        user = await findOne(campaignId, {email:data.email});

        if (user) {
            for (const field in data){
                if (field === 'name' && noNameUpdate){
                    continue;
                }
                if (_.has(user, field)){
                    user[field] = data[field];
                }
            }
            await update(campaignId, user.id, user);
            return await get(campaignId, user.id);

        } else {
            const id = await create(campaignId, data);

            return await get(campaignId, id);
        }
    }
};


function validate(data){
    if (_.has(data, 'name') && ! validator.isLength(data.name, {min:2, max:255})){
        return false;
    }
    if (_.has(data, 'email') && ! validator.isLength(data.email, {min:3, max:100})){
        return false;
    }
    return true;
}

async function postSelect(user, campaignId){
    // Get the campaign_user record for the specific site/game.
    if (_.isNull(campaignId)){
        user.type = 'none';
        return user;
    }

    const campaign_user = await models.campaign_user.findOne({user_id: user.id, campaign_id: campaignId});
    if (campaign_user){
        user.type = campaign_user.type;
        user.campaignType = campaign_user.type;
        user.notes = campaign_user.notes;
        user.drive_folder = campaign_user.drive_folder;
        user.staff_drive_folder = campaign_user.staff_drive_folder;
        if (campaign_user.name){
            user.sso_name = user.name;
            user.name = campaign_user.name;
        }
    } else {
        user.type = 'none';
        user.campaignType = 'unset';
    }

    user.typeForDisplay = user.type;
    if (user.type === 'admin'){
        user.typeForDisplay = 'core staff';
    }

    return user;
}

async function postSave(id, data, campaignId){
    if (!campaignId){
        return;
    }
    let campaign_user = await models.campaign_user.findOne({user_id: id, campaign_id: campaignId});
    if (campaign_user){
        let changed = false;
        for (const field of ['type', 'drive_folder', 'staff_drive_folder', 'notes']){
            if (_.has(data, field) && campaign_user[field] !== data[field]){
                campaign_user[field] = data[field];
                changed = true;
            }
        }
        if (_.has(data, 'campaign_user_name')){
            const user = await get(campaignId, id);
            if (_.has(user, 'sso_name') && user.sso_name === data.campaign_user_name){
                campaign_user.name = null;
                changed = true;
            } else if (user.name !== data.campaign_user_name){
                campaign_user.name = data.campaign_user_name;
                changed = true;
            }
        }

        if (changed){
            await models.campaign_user.update({user_id: (campaign_user.user_id as number), campaign_id:campaignId}, campaign_user);
        }
    } else {
        const campaign = await models.campaign.get(campaignId);
        campaign_user = {
            user_id: id,
            campaign_id: campaignId,
            type: campaign.default_to_player?'player':'none'
        };
        for (const field of ['type', 'drive_folder', 'staff_drive_folder', 'notes']){
            if (_.has(data, field)){
                campaign_user[field] = data[field];
            }
        }
        if (_.has(data, 'campaign_user_name')){
            const user = await get(campaignId, id);
            if (user.name !== data.campaign_user_name){
                campaign_user.name = data.campaign_user_name;
            }
        }
        await models.campaign_user.create(campaign_user);
    }
}

export = {
    get: get,
    find: find,
    findOne: findOne,
    create: create,
    update: update,
    delete: remove,
    findOrCreate: findOrCreate
};
