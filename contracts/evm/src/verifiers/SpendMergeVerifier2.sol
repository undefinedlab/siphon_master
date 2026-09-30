// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 merge2 zkey sha256=aa845dcb3db161c6ec785da3f9d5cfe56caa52b5142dad95f3c0c2394e89bb7d
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendMergeVerifier2 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 9797853914451377314289131899357290556786156071310686350269168774686406684010;
    uint256 constant IC0y = 4812546217903165789709936589329907747243062597158790291959652014121945835261;

    uint256 constant IC1x = 20036097411754632441397574435348263794913180330504388963420120327214192172506;
    uint256 constant IC1y = 6102058595432721345206963454635083453083758491172121522984212305624279459576;

    uint256 constant IC2x = 4637523099167700449105625616257346474067184112184199000124354521364870240350;
    uint256 constant IC2y = 5813693945042900056385118519904078056662119850703611851598997902773107731219;

    uint256 constant IC3x = 11522379028022127400461717873519967427649472979448883882545152657680111933191;
    uint256 constant IC3y = 16576513945092577992747831236202919135384527552126927995797368150283954614839;

    uint256 constant IC4x = 8431697917065259396117316917813322354817704277541711273577133843756057092834;
    uint256 constant IC4y = 13753653598903930103527273808415541757345671008748995818617864577159028992874;

    uint256 constant IC5x = 11515789420816006216502668634782804214311002547894222186778182637862712368784;
    uint256 constant IC5y = 20593911230703953517383981507859763053712375308395943832411536317442572490183;

    uint256 constant IC6x = 745631582480810871498926802391011982989089566044611349999333475372579553326;
    uint256 constant IC6y = 728487207572025562625547076299984968903721560931982941074615481178269682282;

    uint256 constant IC7x = 20820710457024255607788319010568423911815103031816214601939306007351745794991;
    uint256 constant IC7y = 21088454916995962651586564893045855406665351864179259366967804026136729725403;

    uint256 constant IC8x = 11067627061354517312550096514864446018635395972288804290953558908626314087876;
    uint256 constant IC8y = 9221064477924588517588426604900167780947247821960296312906482019814452886059;

    uint256 constant IC9x = 20897418809308146479557937051706237959167565477678347165824011098542085265903;
    uint256 constant IC9y = 1165975936858527919632147604248844641362458116355098636939993644371817021707;

    uint256 constant IC10x = 11994202353295622433591117703915836695242182971135398151672945209467695480061;
    uint256 constant IC10y = 14671117071271628145748112915825826809265733292657029838083352219752905727752;

    uint256 constant IC11x = 17602354762410421137282785240800749041334099207487116882392187653339091593820;
    uint256 constant IC11y = 7160971620284613174592439294189525151529718286671065553584761954982956374989;

    uint256 constant IC12x = 14789679634360435070571991923762391779867770569397882754142779170692113926016;
    uint256 constant IC12y = 7485952438331094816485400676676436435001703970567248406247350842843385534617;

    uint256 constant IC13x = 2026239318711457459560925078766195677436156275902807242500843652103486159154;
    uint256 constant IC13y = 73660747452289504205515967620595050918593728114374538793487941080513023167;

    uint256 constant IC14x = 15564273908693522625728850632235320606730137814595468611335023174547876873558;
    uint256 constant IC14y = 14632583284513231070349024565125889368236602648302661774175476887249947514842;

    uint256 constant IC15x = 11457288135199554441140959739252785398821340330215326585230030191173508909423;
    uint256 constant IC15y = 13257619622064021794724533238266101629471487368026842930279427922122797624260;

    uint256 constant IC16x = 19531065242361835002176316073330373179335415795427002478837064588852803261060;
    uint256 constant IC16y = 19240658762477074228115219528599907890123637303957816946080685047868682383350;

    uint256 constant IC17x = 4600838098237854970234225329237958733034476385500566141671144002167217014447;
    uint256 constant IC17y = 19741058905223725844611656263493359915778838544157047595737513633545950519004;

    uint256 constant IC18x = 3862354062179459197356526488602856938791978598052345174828044021388762918677;
    uint256 constant IC18y = 10737999733572149606002907020657736046679041784049242257750312175776274655262;

    uint256 constant IC19x = 6776925806963516754486606264963326993248302913209261524188233440004704662663;
    uint256 constant IC19y = 20533678603672191132292490943709523635079183467738292835185557322881730702741;

    uint256 constant IC20x = 4323108776054768166900667329172614270633404307560908022095526856437078389147;
    uint256 constant IC20y = 14972682994102752435470320078820616250574007107681786456376049853796055260965;

    uint256 constant IC21x = 905654786320490924068706128100842387346890228032168527556292935542016311274;
    uint256 constant IC21y = 4449961020360948801326928375170687319972168382172972632405461468882474688750;

    uint256 constant IC22x = 16456224131941183947746028340327829881704907698044940471064911518906396061678;
    uint256 constant IC22y = 12865941770047215256027189481017474636939555281882399439243404625693966937099;

    uint256 constant IC23x = 1594945440224280171947798867789249825595153190328455191866401917426232750894;
    uint256 constant IC23y = 15837243489549497559864682889495317380292813358169387901882010241869347565251;

    uint256 constant IC24x = 16112722103877477051909757910979579984577899472384946697594695201542104086550;
    uint256 constant IC24y = 17492850746162289711407862475489438362136951515136713548389656288533764055177;

    uint256 constant IC25x = 20994932929051542838121495338184758777000559870182348178906999231944445522138;
    uint256 constant IC25y = 11254430976152879172738505054892639779019068638340521283169871746491490968592;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
